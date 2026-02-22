// @ts-ignore
import initSqlJs from "sql.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";

// Store the DB in the user's home directory so it's shared across npx and local executions
const DATA_DIR = join(os.homedir(), ".unified-sf-docs-mcp");
const DB_PATH = join(DATA_DIR, "salesforce-docs.db");

let db: any = null;
let SQL: any = null;

async function initSql() {
    if (!SQL) {
        SQL = await initSqlJs();
    }
    return SQL;
}

export async function getDatabase() {
    if (!db) {
        const sqljs = await initSql();
        if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

        if (existsSync(DB_PATH)) {
            const buffer = readFileSync(DB_PATH);
            db = new sqljs.Database(buffer);
        } else {
            db = new sqljs.Database();
            initializeDatabaseSchema(db);
        }
    }
    return db;
}

function initializeDatabaseSchema(dbInstance: any) {
    dbInstance.run(`
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            hash TEXT NOT NULL,
            category TEXT,
            last_scraped DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    dbInstance.run(`
        CREATE TABLE IF NOT EXISTS chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_lower TEXT NOT NULL,
            FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
        )
    `);

    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_documents_url ON documents(url)`);
    dbInstance.run(`CREATE INDEX IF NOT EXISTS idx_chunks_document_id ON chunks(document_id)`);
    saveDatabase(dbInstance);
}

export function saveDatabase(dbInstance: any = db) {
    if (dbInstance) {
        const data = dbInstance.export();
        const buffer = Buffer.from(data);
        writeFileSync(DB_PATH, buffer);
    }
}

export async function saveDocument(url: string, title: string, markdown: string, hash: string, category: string) {
    const database = await getDatabase();

    // Check if it already exists and hasn't changed
    const checkStmt = database.prepare('SELECT id, hash FROM documents WHERE url = ?');
    checkStmt.bind([url]);
    let existingId = null;
    let existingHash = null;
    if (checkStmt.step()) {
        const row = checkStmt.get();
        existingId = row[0];
        existingHash = row[1];
    }
    checkStmt.free();

    if (existingId && existingHash === hash) {
        // Unchanged, skip
        return { action: 'skipped', id: existingId };
    }

    if (existingId) {
        // Delete old chunks
        database.run('DELETE FROM chunks WHERE document_id = ?', [existingId]);
        database.run('UPDATE documents SET title = ?, hash = ?, last_scraped = CURRENT_TIMESTAMP WHERE id = ?', [title, hash, existingId]);
    } else {
        database.run('INSERT INTO documents (url, title, hash, category) VALUES (?, ?, ?, ?)', [url, title, hash, category]);
        const res = database.exec('SELECT last_insert_rowid()');
        existingId = res[0].values[0][0];
    }

    // Split markdown into chunks (approx 1000 chars)
    const chunks = splitIntoChunks(markdown, 1000);

    for (let i = 0; i < chunks.length; i++) {
        database.run(
            'INSERT INTO chunks (document_id, chunk_index, content, content_lower) VALUES (?, ?, ?, ?)',
            [existingId, i, chunks[i], chunks[i].toLowerCase()]
        );
    }

    saveDatabase();
    return { action: 'saved', id: existingId };
}

function splitIntoChunks(text: string, maxLen: number): string[] {
    const chunks: string[] = [];
    const paragraphs = text.split('\\n\\n');
    let currentChunk = '';

    for (const p of paragraphs) {
        if ((currentChunk.length + p.length) > maxLen && currentChunk.length > 0) {
            chunks.push(currentChunk.trim());
            currentChunk = '';
        }
        currentChunk += p + '\\n\\n';
    }
    if (currentChunk.trim().length > 0) chunks.push(currentChunk.trim());

    return chunks;
}

export async function searchDocuments(query: string, maxResults: number = 5) {
    const database = await getDatabase();
    const queryLower = query.toLowerCase();
    const searchTerms = queryLower.split(/\\s+/).filter(w => w.length > 2);

    if (searchTerms.length === 0) return [];

    const likeConditions = searchTerms.map(t => 'c.content_lower LIKE ?').join(' OR ');
    const params = searchTerms.map(t => `%${t}%`);

    const sql = `
        SELECT 
            d.id, d.url, d.title, d.category,
            c.content, c.content_lower
        FROM chunks c
        JOIN documents d ON c.document_id = d.id
        WHERE (${likeConditions})
        LIMIT 200
    `;

    const stmt = database.prepare(sql);
    stmt.bind(params);

    const rows: any[] = [];
    const columns = stmt.getColumnNames();
    while (stmt.step()) {
        const rowData = stmt.get();
        const row: any = {};
        columns.forEach((col: string, idx: number) => row[col] = rowData[idx]);
        rows.push(row);
    }
    stmt.free();

    // Score based on word hits
    const scoredRows = rows.map(row => {
        let hits = 0;
        for (const term of searchTerms) {
            if (row.content_lower.includes(term)) hits++;
        }
        const density = hits / searchTerms.length;
        return { ...row, score: density, hits };
    });

    scoredRows.sort((a, b) => b.score - a.score);

    // Deduplicate by URL
    const seenUrls = new Set();
    const finalResults = [];

    for (const row of scoredRows) {
        if (!seenUrls.has(row.url)) {
            seenUrls.add(row.url);
            finalResults.push({
                url: row.url,
                title: row.title,
                category: row.category,
                matchContent: row.content,
                score: row.score
            });
            if (finalResults.length >= maxResults) break;
        }
    }

    return finalResults;
}
