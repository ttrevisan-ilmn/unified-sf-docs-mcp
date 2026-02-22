#!/usr/bin/env node
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { scrapePage, closeBrowser } from "./scraper.js";
import { saveDocument, searchDocuments, getDatabase } from "./db.js";
import { z } from "zod";

const server = new Server(
    { name: "unified-sf-docs-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

const ScrapePageSchema = z.object({
    url: z.string().url(),
    category: z.string().optional().default("general")
});

const MassExtractSchema = z.object({
    rootUrl: z.string().url(),
    maxPages: z.number().int().min(1).max(100).optional().default(20),
    category: z.string().optional().default("general"),
    matchKeyword: z.string().optional().describe("Optional substring. If provided, the crawler will prioritize scraping child links containing this string.")
});

const SearchDocsSchema = z.object({
    query: z.string().min(1).max(500),
    maxResults: z.number().int().min(1).max(20).optional().default(5)
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "scrape_single_page",
                description: "Scrape a single Salesforce documentation page. Returns markdown. If you do not know the exact URL, you should first use a Web Search tool (like Brave or DuckDuckGo) to search for 'site:developer.salesforce.com/docs [topic]' or 'site:help.salesforce.com [topic]', then pass the retrieved URL here.",
                inputSchema: {
                    type: "object",
                    properties: {
                        url: { type: "string" },
                        category: { type: "string" }
                    },
                    required: ["url"]
                }
            },
            {
                name: "mass_extract_guide",
                description: "Spiders a root Salesforce documentation page, extracts hierarchical links, and scrapes them in bulk. Stores contents in a local SQLite database for later searching.",
                inputSchema: {
                    type: "object",
                    properties: {
                        rootUrl: { type: "string", description: "The Table of Contents or landing page." },
                        maxPages: { type: "number", description: "Maximum number of pages to extract (default 20, max 100)." },
                        category: { type: "string" },
                        matchKeyword: { type: "string", description: "Optional substring. If provided, the crawler will prioritize scraping child links containing this string in their URL." }
                    },
                    required: ["rootUrl"]
                }
            },
            {
                name: "search_local_docs",
                description: "Search locally extracted Salesforce documentation in the SQLite database.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        maxResults: { type: "number" }
                    },
                    required: ["query"]
                }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
        if (name === "scrape_single_page") {
            const { url, category } = ScrapePageSchema.parse(args);
            console.error(`Scraping ${url}...`);
            const result = await scrapePage(url);

            if (result.error) {
                return { content: [{ type: "text", text: `Failed to scrape: ${result.error}` }] };
            }

            // Save automatically to local DB
            await saveDocument(url, result.title, result.markdown, result.hash, category);

            return {
                content: [{ type: "text", text: `# ${result.title}\n\n${result.markdown}` }]
            };
        }

        if (name === "mass_extract_guide") {
            const { rootUrl, maxPages, category, matchKeyword } = MassExtractSchema.parse(args);

            console.error(`Starting mass extraction at ${rootUrl}`);

            // Scrape root to get links
            const rootResult = await scrapePage(rootUrl, new URL(rootUrl).origin);
            if (rootResult.error) {
                return { content: [{ type: "text", text: `Root scrape failed: ${rootResult.error}` }], isError: true };
            }

            await saveDocument(rootUrl, rootResult.title, rootResult.markdown, rootResult.hash, category);

            // Bug-08: Optional keyword sorting to prioritize relevant pages
            let allLinks = [...new Set(rootResult.childLinks)].filter(l => l !== rootUrl);
            if (matchKeyword) {
                const keywordLower = matchKeyword.toLowerCase();
                allLinks.sort((a, b) => {
                    const aMatch = a.toLowerCase().includes(keywordLower) ? -1 : 1;
                    const bMatch = b.toLowerCase().includes(keywordLower) ? -1 : 1;
                    return aMatch - bMatch;
                });
            }

            const queue = allLinks.slice(0, maxPages);
            let successRaw = 1;
            let failureCount = 0;
            const successfulUrls: string[] = [rootUrl];
            const failedUrls: string[] = [];

            for (const link of queue) {
                console.error(`Scraping queued link: ${link}`);
                const pg = await scrapePage(link, new URL(rootUrl).origin);
                if (!pg.error) {
                    await saveDocument(pg.url, pg.title, pg.markdown, pg.hash, category);
                    successRaw++;
                    successfulUrls.push(pg.url);
                } else {
                    console.error(`Failed on ${link}: ${pg.error}`);
                    failureCount++;
                    failedUrls.push(link);
                }
            }

            let outputText = `Mass extraction complete.\nSuccessfully extracted and saved ${successRaw} pages:\n`;
            for (const u of successfulUrls) {
                outputText += `- ${u}\n`;
            }
            if (failureCount > 0) {
                outputText += `\nFailed to extract ${failureCount} pages:\n`;
                for (const u of failedUrls) {
                    outputText += `- ${u}\n`;
                }
            }
            outputText += `\nDatabase updated.`;

            return {
                content: [{ type: "text", text: outputText }]
            };
        }

        if (name === "search_local_docs") {
            const { query, maxResults } = SearchDocsSchema.parse(args);
            const results = await searchDocuments(query, maxResults);

            if (results.length === 0) {
                const database = await getDatabase();
                const countStmt = database.prepare('SELECT COUNT(*) FROM documents');
                countStmt.step();
                const rowCount = countStmt.get()[0] as number;
                countStmt.free();

                if (rowCount === 0) {
                    return {
                        content: [{
                            type: "text",
                            text: "No results found in the local database.\n\nNote: If this is a new installation, your local database is currently empty. You must run the `mass_extract_guide` tool on a Salesforce category URL first to index the documentation locally."
                        }]
                    };
                } else {
                    return {
                        content: [{
                            type: "text",
                            text: `No matching documentation found for "${query}". Try different or fewer keywords.`
                        }]
                    };
                }
            }

            let output = `# Search Results for "${query}"\n\n`;
            for (const r of results) {
                output += `## [${r.title}](${r.url})\n*Category: ${r.category}* | *Score: ${(r.score * 100).toFixed(1)}%*\n\n`;
                output += `> ${r.matchContent.substring(0, 500)}...\n\n---\n`;
            }

            return { content: [{ type: "text", text: output }] };
        }

        return {
            content: [{ type: "text", text: `Unknown tool: ${name}` }],
            isError: true
        };
    } catch (e: any) {
        return {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true
        };
    }
});

// Clean up Puppeteer on exit
process.on('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
});

// Required by Smithery.ai for static analysis
export function createSandboxServer() {
    return server;
}

async function main() {
    console.error("Starting Unified Salesforce Docs MCP Server...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Server running on stdio transport.");
}

// Detect if the Smithery.ai diagnostic scanner is trying to evaluate the file
const isSmitheryScanning = process.argv.some(arg =>
    typeof arg === 'string' && arg.includes('smithery')
);

if (!isSmitheryScanning) {
    // Standard execution natively or via NPX
    main().catch(console.error);
}
