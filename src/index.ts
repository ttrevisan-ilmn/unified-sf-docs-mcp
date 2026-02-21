#!/usr/bin/env node
import { fileURLToPath } from "url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { scrapePage, closeBrowser } from "./scraper.js";
import { saveDocument, searchDocuments } from "./db.js";
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
    category: z.string().optional().default("general")
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
                description: "Scrape a single Salesforce documentation page (handles both developer.salesforce and help.salesforce iframes/structures). Returns markdown.",
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
                        category: { type: "string" }
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
                return { content: [{ type: "text", text: `Failed to scrape: ${result.error}` }], isError: true };
            }

            // Save automatically to local DB
            await saveDocument(url, result.title, result.markdown, result.hash, category);

            return {
                content: [{ type: "text", text: `# ${result.title}\n\n${result.markdown}` }]
            };
        }

        if (name === "mass_extract_guide") {
            const { rootUrl, maxPages, category } = MassExtractSchema.parse(args);

            console.error(`Starting mass extraction at ${rootUrl}`);

            // Scrape root to get links
            const rootResult = await scrapePage(rootUrl, new URL(rootUrl).origin);
            if (rootResult.error) {
                return { content: [{ type: "text", text: `Root scrape failed: ${rootResult.error}` }], isError: true };
            }

            await saveDocument(rootUrl, rootResult.title, rootResult.markdown, rootResult.hash, category);

            const queue = [...new Set(rootResult.childLinks)].filter(l => l !== rootUrl).slice(0, maxPages);
            let successRaw = 1;
            let failureCount = 0;

            for (const link of queue) {
                console.error(`Scraping queued link: ${link}`);
                const pg = await scrapePage(link, new URL(rootUrl).origin);
                if (!pg.error) {
                    await saveDocument(pg.url, pg.title, pg.markdown, pg.hash, category);
                    successRaw++;
                } else {
                    console.error(`Failed on ${link}: ${pg.error}`);
                    failureCount++;
                }
            }

            return {
                content: [{ type: "text", text: `Mass extraction complete.\nSuccessfully extracted and saved ${successRaw} pages.\nFailed: ${failureCount} pages.\nDatabase updated.` }]
            };
        }

        if (name === "search_local_docs") {
            const { query, maxResults } = SearchDocsSchema.parse(args);
            const results = await searchDocuments(query, maxResults);

            if (results.length === 0) {
                return { content: [{ type: "text", text: "No results found in the local database." }] };
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
