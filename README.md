# TextWeb

**A markdown web renderer for AI agents — see the web without screenshots.**

Instead of taking expensive screenshots and piping them through vision models, TextWeb renders web pages as markdown that LLMs can reason about natively. Full JavaScript execution, spatial layout preserved, interactive elements annotated.


## Quick Start

```bash
npm install @playwright/test
npm install playwright-extra puppeteer-extra-plugin-stealth cheerio
npx playwright install chromium
In case of missing dependencies (requires root): npx playwright install --with-deps chromium

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
Navigating to: https://fdroid.org
[button]<1>

https://keepandroidopen.org/<2>

[link]<3>

APPS<4>

NEWS<5>

DOCS<6>

ISSUES<7>

CONTRIBUTE<8>

ABOUT<9>


### Your trusted home for Free and Open Source Mobile Apps

English<10>


### Find Apps

F-Droid is the app distribution ecosystem for Android where your user freedom comes first. Discover our app store, explore the world of free and open source (FOSS) apps and learn<11> about our app distribution tools.

q<12>

[Search]<13>

DOWNLOAD F-DROID<14>

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

The server exposes the following tools:

| Tool | Description                                                                                                                          |
|------|--------------------------------------------------------------------------------------------------------------------------------------|
| `textweb_ddg_search` | Search DuckDuckGo via HTTP POST (no browser). Returns up to 20 structured results (title, link, snippet). Optimized for reliability. |
| `textweb_navigate` | Navigate to a URL and render the page as markdown with annotated interactive elements. Primary way to view web pages.                |
| `textweb_navigate_back` | Navigate back in browser history.                                                                                                    |
| `textweb_click` | Click an interactive element by its reference number. Returns updated markdown after the click.                                      |
| `textweb_type` | Type text into an input field by its reference number. Clears existing content and types the new text.                               |
| `textweb_select` | Select an option from a dropdown/select element by its reference number.                                                             |
| `textweb_scroll` | Scroll the page up or down (or top). Returns the updated markdown text for the new page.                                             |
| `textweb_snapshot` | Re-render the current page as markdown without navigating. Useful after waiting for dynamic content.                                 |
| `textweb_press` | Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown). Returns updated markdown.                                                |
| `textweb_session_list` | List active sessions and basic metadata (url, age).                                                                                  |
| `textweb_session_close` | Close one session by session_id, or all sessions when `all=true`.                                                                    |
| `textweb_upload` | Upload a file to a file input element by its reference number.                                                                       |
| `textweb_storage_save` | Save current browser storage state (cookies/localStorage/sessionStorage) to disk for later restore.                                  |
| `textweb_storage_load` | Load storage state from disk into a fresh browser context.                                                                           |
| `textweb_wait_for` | Wait for UI state in multi-step flows. Supports selector text, and url_includes checks.                                              |
| `textweb_assert_field` | Assert a field value/text by element ref. Useful in multi-step forms before submitting.                                              |

#### Usage Example
With this your LLM can do things like:

```
navigate https://example.com

type 1 password

click 2

```


## Donate
<pre>Send a coffee to 
woheller69@t-online.de 
<a href= "https://www.paypal.com/signin"><img  align="left" src="https://www.paypalobjects.com/webstatic/de_DE/i/de-pp-logo-150px.png"></a>

  
Or via this link (with fees)
<a href="https://www.paypal.com/donate?hosted_button_id=XVXQ54LBLZ4AA"><img  align="left" src="https://img.shields.io/badge/Donate%20with%20Debit%20or%20Credit%20Card-002991?style=plastic"></a></pre>

## Credits
https://github.com/chrisrobison/textweb