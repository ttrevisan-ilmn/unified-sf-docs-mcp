# Unified Salesforce Documentation MCP Server

A powerful Model Context Protocol (MCP) server that empowers LLMs to scrape, digest, and search through modern and legacy Salesforce documentation. It elegantly handles deeply nested Shadow DOMs, typical of Lightning Web Components (LWC), and legacy iframe-based documentation structures.

## Features

-   **Deep Shadow DOM Piercing:** Bypasses 400KB+ of SPA boilerplate on `help.salesforce.com` and `developer.salesforce.com` to extract only the pure article Markdown.
-   **Hierarchical Spidering:** Automatically queues and scrapes all related pages linked from a central guide using `mass_extract_guide`.
-   **Offline RAG Capabilities:** Chunks and indexes scraped Markdown into a local SQLite database (`docs.db`) allowing for instantaneous local search using `search_local_docs`.

## Available Tools

1.  **`scrape_single_page`**: Provide a Salesforce documentation URL. The server will use a headless browser (Puppeteer) to load the page, wait for dynamic content, pierce all shadow DOMs, and return clean Markdown.
2.  **`mass_extract_guide`**: Provide a "Table of Contents" or central guide URL. The server will extract the parent page, find all hierarchical child links, scrape them concurrently, chunk their content, and save them to a local SQLite database for offline querying.
3.  **`search_local_docs`**: Provide a natural language query (e.g., `LWC lifecycle hooks`). The server queries the SQLite database using fuzzy SQL search to instantly return the best matching pre-scraped chunks of documentation.
4.  **`read_local_document`**: Rapidly extracts the full Markdown content of a documentation page that has already been indexed locally, instantly returning the content without needing to re-run headless Chromium to bypass CDNs.

## Quick Start Installation

For anyone downloading this project for the first time:

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/tmtrevisan/unified-sf-docs-mcp.git
    cd unified-sf-docs-mcp
    ```
2.  **Install Dependencies:**
    ```bash
    npm install
    ```
3.  **Build the Project:**
    ```bash
    npm run build
    ```
    *(Note: The server runs from the compiled `/dist` directory, so building is required).*
*(Note: To use the tools interactively, integrate this MCP server with an MCP client like Claude Desktop or Cursor.)*

## Testing

You can use the provided test scripts to verify the core functionality or the scraper against different Salesforce URL layouts:

```bash
# Test the database, chunking, and search functionality
npx tsx tests/test-core.js

# Test the robust Shadow DOM scraper against 4 different URL permutations
npx tsx tests/test-all.js
```

## Integrating with AI Assistants

MCP servers act as a bridge between an LLM and local tools. To actually use this server, you need to plug it into an AI coding assistant like **Cursor** or **Claude Desktop**. 

The absolute easiest way to do this is to use `npx`, which will automatically download and run the latest version of the server from NPM.

### 1. Cursor (Recommended)

1. Open Cursor Settings -> Features -> MCP
2. Click **+ Add new MCP server**
3. Configure the settings:
   - **Type**: `command`
   - **Name**: `unified-sf-docs`
   - **Command**: `npx -y unified-sf-docs-mcp`
4. Click Save. Cursor will instantly download the package and surface the 3 new tools to the Cursor Agent.

### 2. Claude Desktop

1. Open the Claude Desktop configuration file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Add the following entry to your `mcpServers` object:

```json
{
  "mcpServers": {
    "unified-sf-docs": {
      "command": "npx",
      "args": [
        "-y",
        "unified-sf-docs-mcp"
      ]
    }
  }
}
```
3. Restart Claude Desktop. The tools will now be available when talking to Claude!

---

### Alternative: Running a Local Clone
If you want to modify the source code yourself, you can point your AI assistant to a local installation instead of using `npx`:

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/tmtrevisan/unified-sf-docs-mcp.git
    cd unified-sf-docs-mcp
    ```
2.  **Install & Build:**
    ```bash
    npm install && npm run build
    ```
3.  **Update your MCP config:**
    - Type: `command`
    - Command: `node /ABSOLUTE/PATH/TO/unified-sf-docs-mcp/dist/index.js`
