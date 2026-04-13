#!/usr/bin/env node

/**
 * TextWeb MCP Server
 *
 * Model Context Protocol server that gives any MCP client
 * (Claude Desktop, Cursor, Windsurf, Cline, OpenClaw, etc.)
 * text-based web browsing capabilities.
 *
 * Communicates over stdio using JSON-RPC 2.0 or streamable http
 */

const { AgentBrowser } = require('../src/browser');
const { ensureBrowser } = require('../src/ensure-browser');
const http = require('http');  // ← required for HTTP server
const cheerio = require('cheerio');

const SERVER_INFO = {
  name: 'textweb',
  version: '0.2.2',
};

const SESSION_NOTE = 'Optional session_id to isolate state across flows. Defaults to "default".';

const TOOLS = [
  {
    name: 'textweb_ddg_search',
    description: 'Search DuckDuckGo via HTTP POST (no browser). Returns up to max_results structured results (title, link, snippet). Optimized for reliability — works where browser-based scraping fails (e.g., for obscure domains). Use this for factual searches. Not interactive (no clicking), but highly accurate.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (e.g., "tc83.de")' },
        max_results: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 20)',
          minimum: 1,
          maximum: 20,
          default: 10
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'textweb_navigate',
    description: 'Navigate to a URL and render the page as a structured text grid. Interactive elements are annotated with [ref] numbers for clicking/typing. Returns the text grid view, element map, and page metadata. Use this as your primary way to view web pages. IMPORTANT: The initial view is ~1800px visible. Use textweb_scroll tool to get more.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
        cols: { type: 'number', description: 'Grid width in characters (default: 120)' },
        session_id: { type: 'string', description: SESSION_NOTE },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
      },
      required: ['url'],
    },
  },
  {
    name: 'textweb_click',
    description: 'Click an interactive element by its reference number. Returns the updated text grid after the click (page may navigate or update).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element reference number from the text grid (e.g., 3 for [3])' },
        session_id: { type: 'string', description: SESSION_NOTE },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'textweb_type',
    description: 'Type text into an input field by its reference number. Clears existing content and types the new text. Returns the updated text grid.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element reference number of the input field' },
        text: { type: 'string', description: 'Text to type into the field' },
        session_id: { type: 'string', description: SESSION_NOTE },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'textweb_select',
    description: 'Select an option from a dropdown/select element by its reference number.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element reference number of the select/dropdown' },
        value: { type: 'string', description: 'Value or visible text of the option to select' },
        session_id: { type: 'string', description: SESSION_NOTE },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'textweb_scroll',
    description: 'Scroll the page up or down. Returns the updated text grid showing the new viewport position.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Number of pages to scroll (default: 1)' },
        session_id: { type: 'string', description: SESSION_NOTE },
      },
      required: ['direction'],
    },
  },
  {
    name: 'textweb_snapshot',
    description: 'Re-render the current page as a text grid without navigating. Useful after waiting for dynamic content to load.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: SESSION_NOTE },
      },
    },
  },
  {
    name: 'textweb_press',
    description: 'Press a keyboard key (e.g., Enter, Tab, Escape, ArrowDown). Returns the updated text grid.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")' },
        session_id: { type: 'string', description: SESSION_NOTE },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
      },
      required: ['key'],
    },
  },
  {
    name: 'textweb_session_list',
    description: 'List active textweb sessions and basic metadata (url, age).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'textweb_session_close',
    description: 'Close one session by session_id, or all sessions when all=true.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id to close (default: default)' },
        all: { type: 'boolean', description: 'Close all active sessions' },
      },
    },
  },
  {
    name: 'textweb_upload',
    description: 'Upload a file to a file input element by its reference number.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element reference number of the file input' },
        path: { type: 'string', description: 'Absolute path to the file to upload' },
        session_id: { type: 'string', description: SESSION_NOTE },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
      },
      required: ['ref', 'path'],
    },
  },
  {
    name: 'textweb_storage_save',
    description: 'Save current browser storage state (cookies/localStorage/sessionStorage) to disk for later restore.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to write storage state JSON' },
        session_id: { type: 'string', description: SESSION_NOTE },
      },
      required: ['path'],
    },
  },
  {
    name: 'textweb_storage_load',
    description: 'Load storage state from disk into a fresh browser context.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of previously saved storage state JSON' },
        cols: { type: 'number', description: 'Grid width in characters (default: 120)' },
        session_id: { type: 'string', description: SESSION_NOTE },
      },
      required: ['path'],
    },
  },
  {
    name: 'textweb_wait_for',
    description: 'Wait for UI state in multi-step flows. Supports selector, text, and url_includes checks.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector that must appear (or match state)' },
        text: { type: 'string', description: 'Text that must appear in page body' },
        url_includes: { type: 'string', description: 'Substring that must appear in current URL' },
        state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden'], description: 'Selector wait state (default: visible)' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 10000)' },
        poll_ms: { type: 'number', description: 'Polling interval for text/url waits (default: 100)' },
        retries: { type: 'number', description: 'Retry attempts for flaky transitions' },
        retry_delay_ms: { type: 'number', description: 'Delay between retries in ms' },
        session_id: { type: 'string', description: SESSION_NOTE },
      },
    },
  },
  {
    name: 'textweb_assert_field',
    description: 'Assert a field value/text by element ref. Useful in multi-step forms before submitting.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element reference number from current snapshot' },
        expected: { type: 'string', description: 'Expected value/content' },
        comparator: { type: 'string', enum: ['equals', 'includes', 'regex', 'not_empty'], description: 'Comparison mode (default: equals)' },
        attribute: { type: 'string', description: 'Optional DOM attribute name to validate (e.g., aria-invalid)' },
        session_id: { type: 'string', description: SESSION_NOTE },
      },
      required: ['ref', 'expected'],
    },
  },
];

// ─── DuckDuckGo Search (HTTP POST, no browser) ─────────────────────────────
const https = require('https');
const zlib = require('zlib');

async function ddgSearch(query, maxResults = 10) {
  const queryEncoded = encodeURIComponent(query);

  // Build exact POST body (like Python's data={"q": query, "b": "", "kl": ""})
  const body = `q=${queryEncoded}&b=&kl=`;

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(body),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
    'Referer': 'https://duckduckgo.com/',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate',
    'DNT': '1',
    'Sec-GPC': '1',
    'Connection': 'keep-alive',
  };

  return new Promise((resolve, reject) => {
    // ✅ ALL variables declared in outer scope
    let chunks = [];
    let responseText = '';
    let decompressed = false;

    const req = https.request(
      {
        hostname: 'lite.duckduckgo.com',
        path: '/lite/',
        method: 'POST',
        headers: headers,
        timeout: 10000,
        minVersion: 'TLSv1.2',
      },
      (res) => {
        res.on('data', (chunk) => {
          chunks.push(chunk);
        });

        res.on('end', () => {
          try {
            // ✅ Properly reconstruct response
            const buffer = Buffer.concat(chunks);
            responseText = buffer.toString('utf8');

            // Handle gzip (DDG Lite often compresses POST responses)
            if (res.headers['content-encoding'] === 'gzip') {
              try {
                responseText = zlib.gunzipSync(buffer).toString('utf8');
                decompressed = true;
              } catch (gzipErr) {
                console.error('⚠️ GZIP decompression failed, using raw:', gzipErr.message);
              }
            }

            // Safety check
            if (!responseText || responseText.length < 100) {
              const msg = `DDG returned empty/tiny response (${responseText.length} chars). Response preview: ${responseText.substring(0, 200)}`;
              console.error(msg);
              return reject(new Error(msg));
            }

            // Load HTML with Cheerio
            const $ = cheerio.load(responseText);
            const results = [];

            // Look for rows containing a link with class="result-link"
            $('tr').each((i, row) => {
              const $row = $(row);
              const $link = $row.find('a.result-link').first();

              if (!$link.length) return; // Not a result row

              const href = $link.attr('href');
              if (!href) return; // Skip empty hrefs

              // Unwrap DDG redirect
              let finalUrl = href;
              if (href.includes('uddg=')) {
                try {
                  const match = href.match(/uddg=(.+?)(&|$)/);
                  if (match && match[1]) {
                    finalUrl = decodeURIComponent(match[1]);
                  }
                } catch (e) {
                  return; // Skip broken redirects
                }
              }

              // Skip tracking links
              if (finalUrl.includes('y.js')) return;

              const title = $link.text().trim();

              // Get snippet from the *next* result-snippet row
              const snippet = $row.nextAll('tr').has('td.result-snippet').first()
                .find('td.result-snippet')
                .text()
                .trim();

              results.push({
                position: results.length + 1,
                title,
                link: finalUrl,
                snippet
              });

              if (results.length >= maxResults) return false; // break
            });



            const text = results.length
              ? `DuckDuckGo search for "${query}":\n\n` +
                results.map(r => `[${r.position}] ${r.title}\n${r.link}\n${r.snippet}\n`).join('\n')
              : `No results found for "${query}". Try rephrasing your query.`;

            resolve(text);
          } catch (err) {
            // ✅ Safe: use responseText from outer scope (already defined)
            const preview = responseText.substring(0, 500);
            reject(new Error(`Failed to parse DDG results: ${err.message}\n\nRaw HTML preview:\n${preview}`));
          }
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('DDG search timed out'));
    });

    // Send POST body
    req.write(body);
    req.end();
  });
}


// ─── Browser Sessions ───────────────────────────────────────────────────────

/** @type {Map<string, AgentBrowser>} */
const sessions = new Map();

function resolveSessionId(args = {}) {
  return (args.session_id || 'default').trim() || 'default';
}

async function getBrowser(args = {}) {
  const sessionId = resolveSessionId(args);
  let browser = sessions.get(sessionId);

  if (!browser) {
    browser = new AgentBrowser({ cols: args.cols || 120, headless: true });
    await browser.launch();
    sessions.set(sessionId, browser);
  }

  return { browser, sessionId };
}

function formatResult(result) {
  const refs = Object.entries(result.elements || {})
    .map(([ref, el]) => `[${ref}] ${el.semantic}: ${el.text || '(no text)'}`)
    .join('\n');

  return `URL: ${result.meta?.url || 'unknown'}\nVisible range (px): ${result.meta?.scrollY ?? 'unknown'} to ${result.meta?.scrollY+result.meta?.viewport_height || 'unknown'} of ${result.meta?.full_height || 'unknown'}\nTitle: ${result.meta?.title || 'unknown'}\nRefs: ${result.meta?.totalRefs || 0}\n\n${result.view}\n\nInteractive elements:\n${refs}`;
}

function retryOptions(args = {}) {
  return {
    retries: args.retries,
    retryDelayMs: args.retry_delay_ms,
  };
}

async function listSessions() {
  const out = [];
  for (const [sessionId, browser] of sessions.entries()) {
    out.push({
      session_id: sessionId,
      url: browser.getCurrentUrl() || null,
      initialized: Boolean(browser.page),
      refs: browser.lastResult?.meta?.totalRefs ?? null,
    });
  }
  return out;
}

async function closeSession({ session_id, all } = {}) {
  if (all) {
    const closed = [];
    for (const [sid, browser] of sessions.entries()) {
      await browser.close();
      closed.push(sid);
    }
    sessions.clear();
    return { closed };
  }

  const sid = (session_id || 'default').trim() || 'default';
  const browser = sessions.get(sid);
  if (!browser) {
    return { closed: [], missing: [sid] };
  }

  await browser.close();
  sessions.delete(sid);
  return { closed: [sid] };
}

// ─── Tool Execution ──────────────────────────────────────────────────────────

async function executeTool(name, args = {}) {
  if (name === 'textweb_session_list') {
    const active = await listSessions();
    return JSON.stringify({ count: active.length, sessions: active }, null, 2);
  }

  if (name === 'textweb_session_close') {
    const out = await closeSession({ session_id: args.session_id, all: args.all });
    return JSON.stringify(out, null, 2);
  }

  const { browser: b, sessionId } = await getBrowser(args);

  switch (name) {
  case 'textweb_ddg_search': {
    const query = (args.query || '').trim();
    const maxResults = Math.min(Math.max(1, args.max_results || 10), 20);

    if (!query) {
      throw new Error("textweb_ddg_search requires a non-empty 'query'");
    }

    return await ddgSearch(query, maxResults);
  }
    case 'textweb_navigate': {
      const result = await b.navigate(args.url, retryOptions(args));
      return formatResult(result);
    }
    case 'textweb_click': {
      const result = await b.click(args.ref, retryOptions(args));
      return formatResult(result);
    }
    case 'textweb_type': {
      const result = await b.type(args.ref, args.text, retryOptions(args));
      return formatResult(result);
    }
    case 'textweb_select': {
      const result = await b.select(args.ref, args.value, retryOptions(args));
      return formatResult(result);
    }
    case 'textweb_scroll': {
      const result = await b.scroll(args.direction, args.amount || 1);
      return formatResult(result);
    }
    case 'textweb_snapshot': {
      const result = await b.snapshot();
      return formatResult(result);
    }
    case 'textweb_press': {
      const result = await b.press(args.key, retryOptions(args));
      return formatResult(result);
    }
    case 'textweb_upload': {
      const result = await b.upload(args.ref, args.path, retryOptions(args));
      return formatResult(result);
    }
    case 'textweb_storage_save': {
      const out = await b.saveStorageState(args.path);
      return `Saved storage state for session "${sessionId}" to ${out.path}`;
    }
    case 'textweb_storage_load': {
      const out = await b.loadStorageState(args.path);
      return `Loaded storage state for session "${sessionId}" from ${out.path}`;
    }
    case 'textweb_wait_for': {
      const result = await b.waitFor({
        selector: args.selector,
        text: args.text,
        urlIncludes: args.url_includes,
        timeoutMs: args.timeout_ms,
        pollMs: args.poll_ms,
        state: args.state,
        ...retryOptions(args),
      });
      return formatResult(result);
    }
    case 'textweb_assert_field': {
      const out = await b.assertField(args.ref, args.expected, {
        comparator: args.comparator,
        attribute: args.attribute,
      });
      return `ASSERT ${out.pass ? 'PASS' : 'FAIL'} | ref=${out.ref} | comparator=${out.comparator} | expected="${out.expected}" | actual="${out.actual}" | selector=${out.selector}`;
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── JSON-RPC / MCP Protocol ────────────────────────────────────────────────

function jsonrpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonrpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return jsonrpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
      return null; // No response needed

    case 'tools/list':
      return jsonrpc(id, { tools: TOOLS });

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const text = await executeTool(name, args || {});
        return jsonrpc(id, {
          content: [{ type: 'text', text }],
        });
      } catch (err) {
        return jsonrpc(id, {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return jsonrpc(id, {});

    default:
      if (id) return jsonrpcError(id, -32601, `Method not found: ${method}`);
      return null;
  }
}

// ─── CLI & Transport Setup ───────────────────────────────────────────────────
// Declare CLI args and options (needed since they were missing)
const args = process.argv.slice(2);
const options = {};
options.verbose = false; // default

// Extend existing CLI parsing — keep existing logic, just add verbose
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--verbose' || arg === '-v') {
    options.verbose = true;
  } else if (arg.startsWith('--host')) {
    const [, val] = arg.split('=');
    options.host = val ?? args[++i];
  } else if (arg.startsWith('--port')) {
    const [, val] = arg.split('=');
    options.port = val ? Number(val) : Number(args[++i]);
  }
}
if (options.host && options.port == null) options.port = 3000;

// Add helper for safe logging (truncates long strings)
function truncate(str, maxLen = 500) {
  if (!str) return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + `... (${str.length - maxLen} chars truncated)`;
}

function log(msg, ...args) {
  if (!options.verbose) return;
  const prefix = `[${new Date().toISOString()}] VERBOSE: `;
  console.error(`${prefix}${msg.replace(/%s/g, args[0])}`);
}

console.error('✅ CLI options:', options);


function main() {
  if (options.host) {
    console.error(`🚀 Starting HTTP server on ${options.host}:${options.port}`);
    startHttpServer(options.host, Number(options.port));
  } else {
    console.error('✅ Running in stdio mode (no --host)');
    startStdioTransport();
  }
}

// ─── stdio Transport (original logic) ────────────────────────────────────────
function startStdioTransport() {
  let buffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;

    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const msg = JSON.parse(trimmed);
        const response = await handleMessage(msg);
        if (response) {
          process.stdout.write(response + '\n');
        }
      } catch (err) {
        process.stdout.write(
          jsonrpcError(null, -32700, `Parse error: ${err.message}`) + '\n'
        );
      }
    }
  });

  process.stdin.on('end', async () => {
    for (const [, browser] of sessions) await browser.close();
    sessions.clear();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    for (const [, browser] of sessions) await browser.close();
    sessions.clear();
    process.exit(0);
  });
}

// ─── HTTP Transport (fully async-safe + verbose) ─────────────────────────────
function startHttpServer(host, port) {
  const server = http.createServer(async (req, res) => {
    // ─── Full HTTP request logging (when verbose) ───────────────────────────
    if (options.verbose) {
      const reqInfo = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
      const headersStr = JSON.stringify(req.headers);
      log('Incoming request: %s\nHeaders: %s', truncate(reqInfo + '\n' + headersStr, 800));
    }

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400',
      });
      if (options.verbose) log('Sent 204 for OPTIONS preflight');
      return res.end();
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      const body = 'Use POST with JSON-RPC messages';
      res.end(body);
      log('Rejected non-POST request: %s', body);
      return;
    }

    // MCP-compliant response headers
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });

    let buffer = '';
    req.on('data', async (chunk) => {
      const chunkStr = chunk.toString();
      if (options.verbose) log('HTTP body chunk (%d bytes)', chunkStr.length);

      buffer += chunkStr;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const msg = JSON.parse(trimmed);
          if (options.verbose) log('Parsed JSON-RPC: id=%s, method=%s', msg.id, msg.method);
          const response = await handleMessage(msg);
          if (response) {
            res.write(response + '\n');
            if (options.verbose) log('Response sent: %s', truncate(response));
          }
        } catch (e) {
          const errResp = jsonrpcError(null, -32700, `Parse error: ${e.message}`);
          res.write(errResp + '\n');
          log('ERROR parsing HTTP line: %s | Line: %s', e.message, truncate(line));
        }
      }
    });

    req.on('end', async () => {
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim());
          if (options.verbose) log('Final parsed message after EOF: id=%s, method=%s', msg.id, msg.method);
          const response = await handleMessage(msg);
          if (response) res.write(response + '\n');
        } catch (e) {
          const errResp = jsonrpcError(null, -32700, `Final buffer parse error: ${e.message}`);
          res.write(errResp + '\n');
          log('ERROR parsing final buffer: %s | Buffer: %s', e.message, truncate(buffer));
        }
      }
      res.end();
      if (options.verbose) log('HTTP request complete (status=%d)', res.statusCode);
    });
  });

  server.on('error', (err) => {
    console.error(`[FATAL] HTTP server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(port, host, () => {
    console.error(`✅ MCP Streamable HTTP server listening on http://${host}:${port}`);
    if (options.verbose) console.error('💡 Tip: Verbose logging enabled.');
  });

  process.on('SIGINT', () => {
    server.close(() => {
      console.error('HTTP server closed');
      process.exit(0);
    });
  });
}

// ─── Launch ────────────────────────────────────────────────────────────────
ensureBrowser().then(main).catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
