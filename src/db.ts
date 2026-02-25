// @ts-ignore
import initSqlJs from "sql.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import os from "os";

// Store the DB in the user's home directory so it's shared across npx and local executions, unless overridden by an ENV var
const DATA_DIR = process.env.SF_DOCS_DB_DIR || join(os.homedir(), ".unified-sf-docs-mcp");
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
        database.run(
            'UPDATE documents SET title = ?, hash = ?, category = ?, last_scraped = CURRENT_TIMESTAMP WHERE id = ?',
            [title, hash, category, existingId]
        );
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
    const paragraphs = text.split('\n\n');
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
    const searchTerms = queryLower.split(/\s+/).filter(w => w.length > 2);

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
        LIMIT 1000
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

    // BUG-10 Fix: Group matching chunks by document URL so we can score the document globally
    const docsByUrl = new Map();
    for (const row of rows) {
        if (!docsByUrl.has(row.url)) {
            docsByUrl.set(row.url, {
                url: row.url,
                title: row.title,
                category: row.category,
                chunks: []
            });
        }
        docsByUrl.get(row.url).chunks.push(row);
    }

    const scoredDocs = [];
    for (const doc of docsByUrl.values()) {
        let docHits = 0;
        let totalFreq = 0;

        // Evaluate each term against the combined content of all matched chunks for this doc
        const combinedLower = doc.chunks.map((c: any) => c.content_lower).join(' ');

        for (const term of searchTerms) {
            if (combinedLower.includes(term)) {
                docHits++;
                // Rough frequency count for tie-breaking
                totalFreq += (combinedLower.split(term).length - 1);
            }
        }

        const density = docHits / searchTerms.length;

        // Find best individual chunk to use as the snippet
        let bestChunk = doc.chunks[0];
        let bestChunkHits = -1;
        for (const c of doc.chunks) {
            let cHits = 0;
            for (const term of searchTerms) {
                if (c.content_lower.includes(term)) cHits++;
            }
            if (cHits > bestChunkHits) {
                bestChunkHits = cHits;
                bestChunk = c;
            }
        }

        scoredDocs.push({
            url: doc.url,
            title: doc.title,
            category: doc.category,
            matchContent: bestChunk.content,
            score: density,
            totalFreq
        });
    }

    // Sort by term coverage hits first, then by raw frequency
    scoredDocs.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.totalFreq - a.totalFreq;
    });

    return scoredDocs.slice(0, maxResults);
}

export async function getDocumentByUrl(url: string) {
    const database = await getDatabase();

    const docStmt = database.prepare('SELECT id, title FROM documents WHERE url = ?');
    docStmt.bind([url]);

    let docId = null;
    let title = null;
    if (docStmt.step()) {
        const row = docStmt.get();
        docId = row[0];
        title = row[1];
    }
    docStmt.free();

    if (!docId) return null;

    const chunkStmt = database.prepare('SELECT content FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC');
    chunkStmt.bind([docId]);

    let markdown = '';
    while (chunkStmt.step()) {
        const row = chunkStmt.get();
        markdown += row[0] + '\n\n';
    }
    chunkStmt.free();

    return { title, markdown: markdown.trim() };
}

export async function exportLocalDocuments(outputPath: string, urlPrefix?: string, category?: string) {
    const database = await getDatabase();

    let query = 'SELECT d.id, d.title, d.url FROM documents d';
    const conditions = [];
    const params = [];

    if (urlPrefix) {
        conditions.push('d.url LIKE ?');
        params.push(`${urlPrefix}%`);
    }

    if (category) {
        conditions.push('d.category = ?');
        params.push(category);
    }

    if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY d.url ASC';

    const docStmt = database.prepare(query);
    docStmt.bind(params);

    const documents = [];
    while (docStmt.step()) {
        const row = docStmt.get();
        documents.push({ id: row[0], title: row[1], url: row[2] });
    }
    docStmt.free();

    if (documents.length === 0) {
        return { success: false, count: 0, message: "No documents matched the provided filters." };
    }

    let combinedMarkdown = `# Filtered Export (${documents.length} pages)\n\n`;
    if (urlPrefix) combinedMarkdown += `**URL Prefix:** \`${urlPrefix}\`\n`;
    if (category) combinedMarkdown += `**Category:** \`${category}\`\n`;
    combinedMarkdown += `---\n\n`;

    // Extract chunks for each matched document
    for (const doc of documents) {
        const chunkStmt = database.prepare('SELECT content FROM chunks WHERE document_id = ? ORDER BY chunk_index ASC');
        chunkStmt.bind([doc.id]);

        let markdown = '';
        while (chunkStmt.step()) {
            const row = chunkStmt.get();
            markdown += row[0] + '\n\n';
        }
        chunkStmt.free();

        // Append to the giant file
        combinedMarkdown += `# ${doc.title}\n`;
        combinedMarkdown += `**Source:** [${doc.url}](${doc.url})\n\n`;
        combinedMarkdown += `${markdown.trim()}\n\n---\n\n`;
    }

    // Write directly to user's disk
    writeFileSync(outputPath, combinedMarkdown, { encoding: 'utf-8' });

    return {
        success: true,
        count: documents.length,
        message: `Successfully exported ${documents.length} documents to ${outputPath}`
    };
}
