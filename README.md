# TextWeb

**A markdown web renderer for AI agents — see the web without screenshots.**

Instead of taking expensive screenshots and piping them through vision models, TextWeb renders web pages as markdown that LLMs can reason about natively. Full JavaScript execution, spatial layout preserved, interactive elements annotated.


## Quick Start

```bash
npm install @playwright/test
npm install playwright-extra puppeteer-extra-plugin-stealth cheerio
npx playwright install chromium
In case of missing dependencies (requires root): npx playwright install --with-deps chromium)

git clone https://github.com/woheller69/textweb.git
cd textweb/src

node cli.js --interactive https://github.com

#Or global installation
cd textweb
npm install -g .

```

```bash
# Render any page
node cli.js https://news.ycombinator.com

#Or with global installation
textweb https://news.ycombinator.com

# Interactive mode
node cli.js--interactive https://github.com

```

## Example Output

```
[0]Hacker News [1]new | [2]past | [3]comments | [4]ask | [5]show | [6]jobs | [7]submit      [8]login

 1. [9]Show HN: TextWeb – text-grid browser for AI agents (github.com)
    142 points by chrisrobison 3 hours ago | [10]89 comments
 2. [11]Why LLMs don't need screenshots to browse the web
    87 points by somebody 5 hours ago | [12]34 comments

[13:______________________] [14 Search]
```

~500 bytes. An LLM can read this, understand the layout, and say "click ref 9" to open the first link. No vision model needed.

## MCP Server

The fastest way to add web browsing to any MCP-compatible client.

```bash
# Install
npm install playwright-extra puppeteer-extra-plugin-stealth
npx playwright install chromium
git clone https://github.com/woheller69/textweb.git
cd textweb/mcp
npm install cheerio  #must be installed in textweb/mcp directory!

#To run in stdio mode
node mcp/index.js
textweb-mcp

#To run in streamable http mode
node mcp/index.js --host=.... --port=...
textweb-mcp --host= --port=...
```

### MCP Tools
