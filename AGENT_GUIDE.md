# Unified SF Docs MCP Server - Agent Usage Guide

This document provides rules and best practices for AI agents (like Cursor, Claude, or DevBots) interacting with the `unified-sf-docs` MCP Server.

## Overview
The Unified SF Docs MCP Server provides three tools:

| Tool | Purpose |
|------|---------|
| `search_local_docs` | Instantly search an offline SQLite database of pre-scraped documentation |
| `scrape_single_page` | Extract a specific page's content as Markdown, automatically bypassing Shadow DOMs |
| `mass_extract_guide` | Recursively spider a guide's Table of Contents and index all child pages into the local DB |

---

## Agent Rules

### Rule 1: Always Search the DB First
Before attempting to actively scrape the web for an answer, **always** use `search_local_docs` to check if the answer already exists in the local offline database (`docs.db`).
- Example: "How do LWC lifecycle hooks work?" -> Run `search_local_docs({ query: "LWC lifecycle hooks" })`.

### Rule 2: Fallback to Scraping
If the local database does not yield the required information, or the user explicitly asks you to read a specific URL, use `scrape_single_page`.
- The server automatically handles complex Shadow DOM structures (both legacy `doc-xml-content` and modern `slds-text-longform`). You do *not* need to specify DOM selectors. 

### Rule 3: Use Mass Extract for New Guides
If the user is working with a completely new Salesforce product or guide that isn't currently in the local knowledge base, suggest using `mass_extract_guide` on the root table-of-contents URL.
- This proactively spiders and indexes up to 100 pages from the guide into the database, dramatically speeding up future `search_local_docs` queries.

### Rule 4: Compose with Web Search (On-Demand RAG)
If the user asks a complex question about an unknown Salesforce concept and it is NOT in the local database, DO NOT arbitrarily scrape root URLs hoping to find it.
Instead, use a registered Web Search MCP (like `brave_web_search`) to query `"site:developer.salesforce.com/docs OR site:help.salesforce.com [concept]"`. Then, pass the resulting high-value URLs directly into `scrape_single_page` to autonomously read the exact targeted documentation.

### Rule 5: Never Execute Local Scripts
The `unified-sf-docs-mcp` package contains source files like `scraper.js` and `db.js`. **Do not attempt to execute these files directly via Node.js**.
- You must exclusively use the native MCP tool integration to interact with the server.

---

## Example Workflows

### Scenario 1: Quick Concept Lookup
**User:** "What is an Apex trigger?"
**Agent Action:** 
1. `search_local_docs({ query: "Apex trigger syntax" })`
2. Formulate response based on the top database hits.

### Scenario 2: Deep Dive into a Specific Page
**User:** "Can you read this page and tell me the required fields for the Customer Engagement data model? [URL]"
**Agent Action:**
1. `scrape_single_page({ url: "[URL]" })`
2. Extract the required fields from the returned Markdown payload.

### Scenario 3: Onboarding a New Salesforce Cloud
**User:** "I'm starting development on Health Cloud. Here's the developer guide: [URL]"
**Agent Action:**
1. Note that this is a large, new domain.
2. `mass_extract_guide({ rootUrl: "[URL]", maxPages: 50, category: "Health Cloud" })`
3. Acknowledge that the guide has been indexed and is ready for offline querying.
