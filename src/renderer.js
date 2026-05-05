/**
 * TextWeb Markdown Renderer v2.3 — Fully browser-safe with Synchronous Logging
 * Renders page to Markdown + element map entirely in browser context.
 */

/**
 * Main export: render entire page
 * @param {import('playwright').Page} page - Playwright Page instance
 * @param {Object} options - Rendering options
 * @param {number} [options.scrollY=0] - Vertical scroll position (in viewport pixels)
 * @param {number|null} [options.renderHeight=null] - Current render height; null means full page
 * @returns {Promise<Object>} Render result:
 *   - view {string} – Markdown-formatted content
 *   - elements {Object<string,InteractiveElement>} – Map of interactive elements keyed by ref ID
 *   - meta {Object} – Metadata: scrollY, renderHeight, fullHeight, totalRefs, url, title
 *   - logs {string} – Collected rendering logs
 */

async function renderMarkdown(page, options = {}) {
  const { scrollY = 0, renderHeight = null } = options;

  const result = await page.evaluate(
    ({ scrollY, renderHeight }) => {
      // ─── LOGGING SYSTEM ─────────────────────────────────────────────────────
      // Collect logs in an array. We track the index to ensure correct order.
      const browserLogs = [];
      let logIndex = 0;

      /**
       * Synchronous logging function for browser context.
       * @param {...any} args - Arguments to log
       */
      function renderLog(...args) {
        const message = args.map(arg =>
          typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
        ).join(' ');

        // Append to logs string with newline prefix
        browserLogs.push(`[${logIndex++}] ${message}`);
      }
      // ──────────────────────────────────────────────────────────────────────────

      // ─── ALL HELPER FUNCTIONS (browser context) ─────────────────────────────

      const INCLUDED_SELECTORS = 'p, figcaption, dt, dd, blockquote, h1, h2, h3, h4, h5, h6, div, pre';

      const EXCLUDED_SELECTORS = [  //Exclude these, if they are inside INCLUDED_SELECTORS
          '.devsite-nav-item'              // Ignore devsite navigation items (Android Developer pages)
      ];
      const TABLE_SELECTORS = [
        '.tableContainer'  // Yahoo Finance (start here; add more as needed)
      ];

      const LIST_SELECTORS = ['ol', 'ul'];

      // Exclude list/table subtrees from container text
      const excludedForContainerText = [
        ...LIST_SELECTORS, // ['ul', 'ol']
        ...TABLE_SELECTORS // ['.tableContainer'] (if you want to be extra safe)
      ];

      renderLog('Start render process', { scrollY, renderHeight });

      /**
       * Decode HTML entities safely (in-browser)
       * @param {string} str - Input string potentially containing HTML entities
       * @returns {string} Decoded string
       */
      function decodeHTML(str) {
        if (!str) return '';
        const txt = document.createElement('textarea');
        try {
          txt.innerHTML = str;
          return txt.value;
        } catch (e) {
          return str;
        }
      }

      /**
       * Check if an element is visible, has pointer events enabled, and is interactable via the mouse.
       * @param {Element} el - DOM element to inspect
       * @returns {boolean} true if element is visually and functionally visible
       */
      function hasPointerEvents(el) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          parseFloat(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          style.pointerEvents !== 'none'
        );
      }

      /**
       * Determine whether an element is considered an interactive candidate
       * (i.e., likely triggers UI interaction or navigation).
       * @param {Element} el - DOM element
       * @returns {boolean} true if element matches known interactive element types
       */
      function isInteractiveElement(el) {
        // Exclude 'SPAN' as interactive element. May cause issues if span used as clickable element
        if (['SPAN'].includes(el.tagName)) {
          return false;
        }

        return (
          el.tagName === 'A' ||
          el.tagName === 'BUTTON' ||
          el.tagName === 'INPUT' ||
          el.tagName === 'SELECT' ||
          el.tagName === 'TEXTAREA' ||
          el.getAttribute('role') === 'button' ||
          el.getAttribute('role') === 'link' ||
          (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1')
        );
      }

      /**
       * Create a standardized element map entry for an interactive item.
       * Used to populate the `elements` object returned in render result.
       * @param {number} ref - Unique reference ID for this element
       * @param {Object} item - Element data with properties like tag, selector, href, text, etc.
       * @returns {InteractiveElement} Structured element entry
       */
      function createElementMapEntry(ref, item) {
        const tag = item.tag;
        const type = item.type;

        return {
          selector: item.selector,
          tag: tag,
          semantic: tag === 'a' ? 'link' :
            tag === 'button' || (tag === 'input' && ['submit', 'button'].includes(type)) ? 'button' :
            tag === 'input' && ['checkbox', 'radio'].includes(type) ? type :
            tag,
          href: item.href || null,
          text: item.text,
          label: item.text,
          x: item.x, y: item.y, w: item.w, h: item.h,
          action: getAction(tag === 'a' ? 'link' : tag),
          disabled: !!item.disabled,
          checked: tag === 'input' && ['checkbox', 'radio'].includes(type) ? item.checked || null : null,
          selected: tag === 'select' ? item.selected || null : null,
          required: !!item.required,
          value: item.value || null,
          placeholder: item.placeholder || null,
          name: item.name || null,
          type: type || null,
        };
      }

      /**
       * Build a minimal, stable CSS selector for a given element.
       * Prioritizes ID, then data-* attributes, aria-label, href/name attributes,
       * class names, and finally positional selectors.
       * @param {Element} el - DOM element
       * @returns {string} Stable CSS selector string
       */
      function buildSimpleSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);

        for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-test-id']) {
          const val = el.getAttribute(attr);
          if (val) return `[${attr}="${CSS.escape(val)}"]`;
        }

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
          try {
            if (document.querySelectorAll(sel).length === 1) return sel;
          } catch (e) {}
        }

        if (el.tagName === 'A') {
          const href = el.getAttribute('href');
          if (href && !href.startsWith('javascript:')) {
            const sel = `a[href="${CSS.escape(href)}"]`;
            try {
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (e) {}
          }
        }

        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) && el.name) {
          const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
          try {
            if (document.querySelectorAll(sel).length === 1) return sel;
          } catch (e) {}
        }

        if (
          el.tagName === 'INPUT' &&
          ['text', 'search', 'email', 'password', 'tel', 'url'].includes(el.type || 'text') &&
          el.placeholder
        ) {
          const sel = `input[type="${CSS.escape(el.type || 'text')}"][placeholder="${CSS.escape(el.placeholder)}"]`;
          try {
            if (document.querySelectorAll(sel).length === 1) return sel;
          } catch (e) {}
        }

        if (el.tagName === 'BUTTON' && el.getAttribute('value')) {
          const sel = `button[value="${CSS.escape(el.getAttribute('value'))}"]`;
          try {
            if (document.querySelectorAll(sel).length === 1) return sel;
          } catch (e) {}
        }

        if (el.className && typeof el.className === 'string') {
          const classes = el.className.trim().split(/\s+/).filter(c => c && !/^[\d-]/.test(c));
          for (const cls of classes) {
            const sel = `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`;
            try {
              if (document.querySelectorAll(sel).length === 1) return sel;
            } catch (e) {}
          }
        }

        const parent = el.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(el) + 1;
            const parentSel = parent.id ? `#${CSS.escape(parent.id)}` : parent.tagName.toLowerCase();
            return `${parentSel} > ${el.tagName.toLowerCase()}:nth-of-type(${idx})`;
          }
        }

        if (el.type && el.tagName === 'INPUT') {
          return `${el.tagName.toLowerCase()}[type="${CSS.escape(el.type)}"]`;
        }

        return el.tagName.toLowerCase();
      }

      /**
       * Parse div-based table structure (Yahoo Finance style) into headers and rows.
       * Handles .tableContainer with .tableHeader/.tableBody and .column cells.
       * @param {Element} tableContainer - The .tableContainer DOM element
       * @returns {{ headers: string[], rows: CellData[][] }} Parsed table data compatible with renderTableLLMOptimized
       */
      function parseDivTableStructure(tableContainer) {
        renderLog('Parsing div table structure', tableContainer.tagName);
        const headers = [];
        const rows = [];

        // Extract header row from .tableHeader .row
        const headerRow = tableContainer.querySelector('.tableHeader .row');
        if (headerRow) {
          Array.from(headerRow.querySelectorAll('.column')).forEach(cell => {
            headers.push(decodeHTML(extractTextWithSpaces(cell)));
          });
        }

        // Extract body rows from .tableBody
        const tableBody = tableContainer.querySelector('.tableBody');
        if (tableBody) {
          const bodyRows = Array.from(tableBody.querySelectorAll('.row'));

          bodyRows.forEach(rowEl => {
            const cells = Array.from(rowEl.querySelectorAll('.column'));
            const rowData = cells.map(cell => {
              const text = decodeHTML(extractTextWithSpaces(cell));
              const interactives = Array.from(
                cell.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]')
              ).filter(el => hasPointerEvents(el) && isInteractiveElement(el));

              return {
                text,
                interactives,
                colSpan: 1, // div-tables rarely use colspan/rowspan, but structure matches semantic tables
                rowSpan: 1,
                selector: buildSimpleSelector(cell),
                tag: 'div'
              };
            });
            rows.push(rowData);
          });
        }

        return { headers, rows };
      }
/**
 * Parse standard HTML lists (<ul>, <ol>) into structured data.
 * Extracts direct <li> children, preserves text, and collects interactives.
 * Excludes nested lists from parent item text to avoid flattening.
 */
function parseListStructure(listEl) {
  renderLog('Parsing list structure', listEl.tagName, listEl.className);
  const isOrdered = listEl.tagName.toLowerCase() === 'ol';
  const items = [];

  // Only process direct <li> children
  const lis = Array.from(listEl.children).filter(el => el.tagName.toLowerCase() === 'li');
  renderLog(`Found ${lis.length} direct <li> children in ${listEl.className || listEl.tagName}`);

  for (const li of lis) {
    if (!hasPointerEvents(li)) continue;

    // ✅ Extract text while explicitly skipping nested list subtrees
    const text = extractTextExcludingNestedLists(li).trim();
    renderLog(`LI text extracted: "${text?.substring(0, 100)}${text?.length > 100 ? '...' : ''}"`);

    if (!text) {
      renderLog('Skipping LI with empty text after nested list exclusion');
      continue;
    }

    // Collect interactives from the ORIGINAL li (not filtered)
    const interactives = Array.from(
      li.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]')
    ).filter(el => hasPointerEvents(el) && isInteractiveElement(el));

    items.push({ text, interactives });
  }

  renderLog(`Parsed ${items.length} items from list ${listEl.className || listEl.tagName}`);
  return { isOrdered, items };
}

/**
 * Extract text from an element while skipping any subtrees that are nested lists.
 * Prevents flattening of nested LIST_SELECTORS into parent list items.
 */
function extractTextExcludingNestedLists(el) {
  const parts = [];
  const isPre = el.tagName.toLowerCase() === 'pre';

  // Create a TreeWalker but skip nested list elements entirely
  const walker = document.createTreeWalker(
    el,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Check if this text node is inside a nested list
        let parent = node.parentElement;
        while (parent && parent !== el) {
          const tag = parent.tagName.toLowerCase();
          if (LIST_SELECTORS.includes(tag)) {
            return NodeFilter.FILTER_REJECT; // Skip this entire subtree
          }
          parent = parent.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent) continue;

    // Skip invisible text (same checks as extractTextWithSpaces)
    const style = getComputedStyle(parent);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity) === 0 ||
      parent.offsetParent === null
    ) {
      continue;
    }

    const text = node.textContent;
    if (text) {
      parts.push(isPre ? text : text.trim());
    }
  }

  return parts.length === 0
    ? ''
    : (isPre ? parts.join('') : parts.join(' ').trim());
}


      /**
       * Parse HTML table structure into headers and rows with interactive references.
       * Handles colspan/rowspan and deduplication of spanning cells.
       * @param {Element} table - Table DOM element
       * @returns {{ headers: string[], rows: CellData[][] }} Parsed table data
       */
      function parseTableStructure(table) {
        renderLog('Parsing semantic table structure', table.tagName);
        const headers = [];
        const rows = [];

        const firstRow = table.querySelector('tr');
        if (!firstRow) return { headers: [], rows: [] };

        // Check if first row contains <th> elements
        const hasTh = firstRow.querySelector('th') !== null;

        if (hasTh) {
          // Use <th> cells as headers
          firstRow.querySelectorAll('th').forEach(cell => {
            headers.push(decodeHTML(extractTextWithSpaces(cell)));
          });
        }
        const tbody = table.querySelector('tbody') || table;
        // Use .children + filter to only parse direct rows/cells (prevents nested table leakage)
        const trs = Array.from(tbody.children).filter(el => el.tagName === 'TR');
        const cellMap = [];

        trs.forEach((tr, rowIndex) => {
          const cols = Array.from(tr.children).filter(el => el.tagName === 'TD' || el.tagName === 'TH');
          let colIndex = 0;

          cols.forEach(cell => {
            const { colspan = 1, rowspan = 1 } = cell;
            const text = decodeHTML(extractTextWithSpaces(cell));
            const interactives = Array.from(
              cell.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]')
            ).filter(el => hasPointerEvents(el) && isInteractiveElement(el));

            if (!cellMap[rowIndex]) cellMap[rowIndex] = [];
            while (cellMap[rowIndex].length <= colIndex) cellMap[rowIndex].push(null);

            cellMap[rowIndex][colIndex] = {
              text,
              interactives,
              colSpan: colspan,
              rowSpan: rowspan,
              selector: buildSimpleSelector(cell),
              tag: cell.tagName.toLowerCase()
            };

            for (let c = 1; c < colspan; c++) {
              const targetCol = colIndex + c;
              if (!cellMap[rowIndex]) cellMap[rowIndex] = [];
              while (cellMap[rowIndex].length <= targetCol) cellMap[rowIndex].push(null);
              cellMap[rowIndex][targetCol] = { text: '', interactives: [], isSpan: true };
            }

            colIndex += colspan;
          });
        });

        trs.forEach((tr, rowIndex) => {
          const cols = Array.from(tr.children);
          let colIndex = 0;

          cols.forEach(cell => {
            const { colspan = 1, rowspan = 1 } = cell;
            if (rowspan > 1) {
              const spanFromRow = rowIndex;
              const spanFromCol = colIndex;
              const spanValue = cell.innerText.trim();
              const spanInteractives = Array.from(
                cell.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]')
              ).filter(el => hasPointerEvents(el) && isInteractiveElement(el));

              for (let r = 1; r < rowspan; r++) {
                const targetRow = rowIndex + r;
                if (!cellMap[targetRow]) cellMap[targetRow] = [];
                while (cellMap[targetRow].length <= spanFromCol) cellMap[targetRow].push(null);
                cellMap[targetRow][spanFromCol] = {
                  text: '',
                  interactives: [],
                  isSpan: true,
                  spanFromRow,
                  spanFromCol,
                  spanValue,
                  spanInteractives
                };
              }
            }
            colIndex += colspan;
          });
        });

        cellMap.forEach(rowCells => {
          if (!rowCells) return;
          rows.push(rowCells.map(cell => {
            if (cell?.isSpan) {
              return {
                text: cell.spanValue || '',
                interactives: cell.spanInteractives || [],
                colSpan: 1,
                rowSpan: 1,
                isSpan: true
              };
            }
            return cell || { text: '', interactives: [], colSpan: 1, rowSpan: 1 };
          }));
        });

        return { headers, rows };
      }
      /**
       * * Renders table data into a compact Markdown table optimized for LLM consumption.
       *  * Uses symmetric delimiters ( | ) for clarity while minimizing token usage.
       *
       * Unlike human-focused renderers, this function minimizes token usage by:
       * 1. Removing trailing whitespace (no `padEnd` on cells).
       * 2. Using a fixed minimum separator length (3 dashes) instead of dynamic column width.
       * 3. Simplifying alignment logic to standard `---` (left-aligned) unless specific types require it.
       *
       * @param {{ headers: string[], rows: CellData[][] }} tableData - Table structure from parseTableStructure
       * @returns {string} Markdown table string
       */
      function renderTableLLMOptimized(tableData) {
        const { headers, rows } = tableData;

        // Quick check for empty data
        if (!headers.length && (!rows || !rows.length)) return '';

        // Determine the number of columns based on the longest row
        const cols = Math.max(
          headers.length,
          rows ? Math.max(...rows.map(r => r.length || 0)) : 0
        );

        // Ensure headers have enough columns
        while (headers.length < cols) headers.push('');

        // Ensure rows have enough columns and fill with default objects if necessary
        // (Preserving the structure of your original logic for safety)
        rows.forEach(row => {
          while (row.length < cols) {
            row.push({ text: '', interactives: [], colSpan: 1, rowSpan: 1 });
          }
        });

        // Calculate minimum width for each column (just enough to fit content)
        const colWidths = new Array(cols).fill(3); // Min width of 3 for separator

        headers.forEach((h, i) => colWidths[i] = Math.max(colWidths[i], h.length));
        rows.forEach(row => {
          row.forEach((cell, i) => {
            colWidths[i] = Math.max(colWidths[i], (cell.text || '').length);
          });
        });

        // 1. Header Row: No trailing spaces
        const hRow = '| ' + headers.map((h, i) => h).join(' | ') + ' |';

        // 2. Separator Row: Fixed 3 dashes for all columns to save tokens
        // (No dynamic alignment logic unless explicitly required)
        const sepRow = '| ' + colWidths.map(() => '---').join(' | ') + ' |';

        // 3. Body Rows: No trailing spaces, escape special characters
        const bodyRows = rows.map(row =>
          '| ' + row.map((cell, i) => escapeForLLM(cell.text || '')).join(' | ') + ' |'
        );

        // Return with standard Markdown spacing
        return `\n\n${hRow}\n${sepRow}\n${bodyRows.join('\n')}\n`;
      }

      /**
       * Extract text from an element while preserving spaces/newlines.
       * For <pre>: preserves *all* whitespace/newlines (including indentation).
       * For others: collapses whitespace (as per standard Markdown behavior).
       * ✅ Correctly handles nested spans (e.g., Prism.js, highlight.js).
       * @param {Element} el - DOM element
       * @param {string[]} [excludedSelectors] - Optional list of selectors whose subtrees should be excluded (e.g., ['ul', 'ol', '.tableContainer'])
       * @returns {string} Text with appropriate whitespace handling
       */
      function extractTextWithSpaces(el, excludedSelectors = []) {
        const isPre = el.tagName.toLowerCase() === 'pre';

        // ✅ Use innerText for <pre> — it respects styling, newlines, indentation, and handles nested spans correctly
        if (isPre) {
          return el.innerText || '';
        }

        // ✅ Create TreeWalker with dynamic exclusion logic
        const walker = document.createTreeWalker(
          el,
          NodeFilter.SHOW_TEXT,
          {
            acceptNode: (node) => {
              const parent = node.parentElement;
              if (!parent) return NodeFilter.FILTER_REJECT; // Safety

              // ✅ 1. Skip invisible text (original logic)
              const style = getComputedStyle(parent);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity) === 0 ||
                parent.offsetParent === null
              ) {
                return NodeFilter.FILTER_SKIP;
              }

              // ✅ 2. Skip if inside any excluded selector (NEW)
              for (const sel of excludedSelectors) {
                // Check if *any ancestor* matches the selector
                if (parent.closest?.(sel)) {
                  return NodeFilter.FILTER_REJECT; // Reject this subtree entirely
                }
              }

              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        const parts = [];
        let node;

        while ((node = walker.nextNode())) {
          const text = node.textContent;
          if (text) {
            parts.push(text);
          }
        }

        // ✅ Collapse whitespace for non-<pre> blocks
        return parts.length === 0
          ? ''
          : parts.join(' ').trim();
      }

      /**
       * Escape text for Markdown (and downstream LLM processing) by escaping special characters.
       * Also decodes HTML entities and normalizes whitespace.
       * ✅ Do NOT escape `*` '|' or `_`: they're safe in identifiers, URLs, and most text contexts.
       *  LLMs and Markdown parsers only treat them as formatting when surrounded by whitespace.
       * @param {string} str - Input string
       * @returns {string} Escaped and normalized string
       */
      function escapeForLLM(str) {
        if (!str) return '';
        str = decodeHTML(str);
        return str
          .replace(/([`<>\\~])/g, '\\$1')   // changed from .replace(/([*_`<>\\|~])/g, '\\$1')
          .replace(/\u00A0/g, ' ')
          .replace(/\n+/g, ' ');
      }

      /**
       * Embed an interactive reference into target text using @@REFn@@ placeholder.
       * Tries regex match first, then optionally appends reference as fallback.
       * Updates the element map with the new entry.
       * @param {string} targetText - The text to search/modify
       * @param {Object} item - The interactive item (must have `.text` property)
       * @param {Object} elementMap - Mutable map to register the ref entry
       * @param {number} refId - Current reference counter (will be incremented if inserted)
       * @param {Object} [options] - Options
       * @param {boolean} [options.fallbackAppend=false] - Whether to append fallback if no regex match
       * @returns {{ text: string, refId: number, ref: number|null, matched: boolean }}
       *   - text {string} Updated text (with reference or unchanged)
       *   - refId {number} Updated ref counter
       *   - ref {number|null} ID of inserted reference (or null if not inserted)
       *   - matched {boolean} Whether regex matched the reference text
       */
      function embedInteractiveRef(targetText, item, elementMap, refId, { fallbackAppend = false } = {}) {
        if (!item || !item.text?.trim()) {
          return { text: targetText, refId, ref: null, matched: false };
        }

        const itemText = item.text.trim();
        const ref = refId++;
        const placeholder = `@@REF${ref}@@`;

        elementMap[ref] = createElementMapEntry(ref, item);

        // Escape for LLM + regex safety
        const escapedItemText = escapeForLLM(itemText);
        const safeText = escapedItemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Boundary-aware regex (matches word + common delimiters)
        // ✅ Fixed: Removed \b boundaries. Expanded delimiter set to handle markdown escaping & HTML tags. The original \b (word boundary) fails in markdown/HTML contexts
        const regex = new RegExp(`(^|[\\s(\\[<\\*\\_])(${safeText})([\\s.:;,!?)\\]>\\*\\_]|$)`, 'i');
        const match = targetText.match(regex);

        if (match) {
          // Preserve surrounding context while injecting placeholder
          targetText = targetText.replace(regex, `${match[1]}${match[2]}${placeholder}${match[3]}`);
          return { text: targetText, refId, ref, matched: true };
        }

        // No match found
        if (fallbackAppend) {
          // Append reference at end as fallback
          targetText = `${targetText}@@REF${ref}@@`;
        }

        return { text: targetText, refId, ref, matched: false };
      }

      /**
       * Truncate text for metadata (e.g., in elementMap).
       * Stops at first newline if within limit, otherwise cuts at maxLen.
       * @param {string} text - Input text
       * @param {number} [maxLen=80] - Maximum length before truncation
       * @returns {string} Truncated text (may end with ellipsis)
       */
      function truncateText(text, maxLen = 80) {
        if (!text) return '';
        text = decodeHTML(text);
        const newlineIndex = text.indexOf('\n');
        const limit = (newlineIndex !== -1 && newlineIndex < maxLen) ? newlineIndex : maxLen;
        if (text.length <= limit) return text;
        return text.substring(0, limit).trim() + '…';
      }

      /**
       * Get the canonical Playwright action name for a given semantic type.
       * @param {string} semantic - Semantic type (e.g., 'link', 'button', 'input')
       * @returns {string} Action name: 'navigate', 'click', 'type', 'select', 'toggle', 'upload'
       */
      function getAction(semantic) {
        const actions = {
          link: 'navigate',
          button: 'click',
          input: 'type',
          textarea: 'type',
          select: 'select',
          checkbox: 'toggle',
          radio: 'select',
          file: 'upload'
        };
        return actions[semantic] || 'click';
      }

      // ─── MAIN EXTRACT + RENDER LOGIC ──────────────────────────────────────────
      renderLog('Beginning DOM Extraction');

      let refId = 1;
      const elementMap = {};
      // 1. Collect interactives
      renderLog('Scanning interactive elements...');
      const allInteractives = [];
      document.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
      ).forEach(el => {
        for (const selector of EXCLUDED_SELECTORS) {
            if (el.closest(selector)) return;
        }
        if (!hasPointerEvents(el) || !isInteractiveElement(el)) return;

        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        if (renderHeight !== null && (top < scrollY || top > scrollY + renderHeight)) return;

        let text = '';
        if (el.tagName === 'INPUT') {
          text = el.value || el.placeholder || el.name || el.id || '[input]';
        } else if (el.tagName === 'SELECT') {
          text = el.options?.[el.selectedIndex]?.text || el.name || '[select]';
        } else if (el.tagName === 'TEXTAREA') {
          text = el.value || el.placeholder || '[textarea]';
        } else if (el.tagName === 'A') {
          text = el.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim() || '[link]';
        } else {
          text = el.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim() || '[button]';
        }
        if (!text) return;

        allInteractives.push({
          el,
          text,
          selector: buildSimpleSelector(el),
          href: el.tagName === 'A' ? (el.href || el.getAttribute('href')) : null,
          x: rect.left + window.scrollX,
          y: top,
          w: rect.width,
          h: rect.height,
          tag: el.tagName.toLowerCase(),
          type: el.type || null,
          name: el.name || null,
          placeholder: el.placeholder || null,
          value: el.value || null,
          checked: el.type === 'checkbox' || el.type === 'radio' ? el.checked || null : null,
          selected: el.type === 'select-one' ? el.selected || null : null,
          disabled: el.disabled || false,
          required: el.required || false
        });
      });

      renderLog(`Found ${allInteractives.length} interactive elements`);

      // 2. Collect containers + tables + orphans
      const results = [];
      const usedInteractives = new Set();

      // Track processed div-based tables to avoid duplicates
      const processedDivTables = new Set();

      // ── Collect and filter containers ────────────────────────────────────────────
      renderLog('Processing containers');

      const allContainers = Array.from(document.querySelectorAll(INCLUDED_SELECTORS));
      const filteredContainers = allContainers.filter((el) => {
        // 1. Remove containers that *contain other matched elements* (keep leaf nodes)
        //    e.g., if <div> contains <p>, keep only <p>, not the wrapper <div>
        if (allContainers.some((other) => other !== el && el.contains(other))) {
          return false;
        }

        // 2. ✅ Exclude semantic tables
        if (el.tagName.toLowerCase() === 'table') return false;

        // 3. ✅ Exclude div-based tables: either via TABLE_SELECTORS OR if it contains a <table>
        if (el.tagName.toLowerCase() === 'div') {
          // First: explicit selectors (e.g., .tableContainer)
          for (const selector of TABLE_SELECTORS) {
            if (el.matches(selector)) return false;
            if (el.closest(selector)) return false;
          }

          // ✅ NEW: Also exclude divs that *contain* a semantic <table>
          if (el.querySelector('table')) return false;
        }

        // 4. ✅ Keep containers *even if* they contain lists/tables — we'll exclude list/table text during extraction
        //    So: DO NOT exclude containers just because they have a list/table inside

        // 5. ✅ Existing exclusions: ads, nav items, etc.
        for (const selector of EXCLUDED_SELECTORS) {
          if (el.closest(selector)) return false;
        }

        // 6. ✅ Skip containers inside semantic tables (double-check)
        if (el.closest('table')) return false;

        // 7. ✅ Skip if *only* contains lists/tables AND has no meaningful text on its own
        if (el.tagName.toLowerCase() === 'div' || el.tagName.toLowerCase() === 'section') {
          const textWithoutListsTables = extractTextWithSpaces(el, [
            ...LIST_SELECTORS,
            ...TABLE_SELECTORS
          ]);

          if (!textWithoutListsTables.trim()) {
            renderLog(`Skipping wrapper container ${el.className || ''} (no non-list/table text)`);
            return false;
          }
        }

        return true;
      });


      // ── Process Lists (Independent of INCLUDED_SELECTORS) ─────────────────────
      renderLog('Processing Lists');

      const allLists = Array.from(document.querySelectorAll(LIST_SELECTORS.join(', ')))
        .filter(list => {
          // ✅ NEW: Skip lists inside tables — treat them as inline content
          if (list.closest('table')) {
            renderLog(`Skipping list ${list.className || list.tagName} inside table`);
            return false;
          }
          return hasPointerEvents(list);
        });

      for (const listEl of allLists) {
        const rect = listEl.getBoundingClientRect();
        const top = rect.top + window.scrollY;

        // Respect render height filtering
        if (renderHeight !== null && (top < scrollY || top > scrollY + renderHeight)) continue;

        const listData = parseListStructure(listEl);
        if (listData.items.length === 0) continue;

        // Embed interactive references inline in list items
        for (const item of listData.items) {
          for (const rawEl of item.interactives) {
            const interactiveItem = allInteractives.find(i => i.el === rawEl);
            if (interactiveItem) {
              let text = item.text;
              ({ text, refId } = embedInteractiveRef(text, interactiveItem, elementMap, refId, { fallbackAppend: true }));
              item.text = text;
            }
          }
        }

        // Mark contained interactives as used so they don't appear as orphans
        const listInteractives = allInteractives.filter(i => listEl.contains(i.el) && !usedInteractives.has(i.el));
        listInteractives.forEach(i => usedInteractives.add(i.el));

        results.push({
          type: 'list',
          y: top,
          data: listData,
          interactives: listInteractives,
          selector: buildSimpleSelector(listEl)
        });
      }
      // ── End list processing ──────────────────────────────────────────────────


      // ── Process div-based tables ────────────────────────────────────────────────
      renderLog('Processing DIV Tables');
      const allDivTableContainers = Array.from(document.querySelectorAll(TABLE_SELECTORS.join(', ')))
        .filter(tc => hasPointerEvents(tc));

      for (const tableContainer of allDivTableContainers) {
        if (processedDivTables.has(tableContainer)) continue;
        processedDivTables.add(tableContainer);

        const rect = tableContainer.getBoundingClientRect();
        const top = rect.top + window.scrollY;

        // Rendered range filtering
        if (renderHeight !== null && (top < scrollY || top > scrollY + renderHeight)) continue;

        // Parse the div-table structure
        const tableData = parseDivTableStructure(tableContainer);
        if (!tableData.headers.length && !tableData.rows.length) continue;

        // ✅ Embed interactive references inline in cells (same logic as semantic tables)
        for (const row of tableData.rows) {
          for (const cell of row) {
            if (cell?.interactives?.length > 0) {
              let text = cell.text;
              for (const rawEl of cell.interactives) {
                const item = allInteractives.find(i => i.el === rawEl);
                if (item) {
                  ({ text, refId } = embedInteractiveRef(text, item, elementMap, refId, { fallbackAppend: true }));
                }
              }
              cell.text = text;
            }
          }
        }

        // Mark contained interactives as used
        const tableInteractives = allInteractives.filter(item =>
          tableContainer.contains(item.el) && !usedInteractives.has(item.el)
        );
        tableInteractives.forEach(item => usedInteractives.add(item.el));

        // Add to results as a table-type entry
        results.push({
          type: 'table',
          y: top,
          data: tableData,
          interactives: tableInteractives,
          selector: buildSimpleSelector(tableContainer),
          caption: tableContainer.querySelector('.subText')?.innerText.trim() ||
                   tableContainer.querySelector('.currency')?.innerText.trim() || null
        });
      }
      renderLog(`Found ${results.length} tables so far`);
// ── End div-table processing ─────────────────────────────────────────────


      for (const container of filteredContainers) {
        if (!hasPointerEvents(container)) continue;
          // 👇 NEW: Detect and mark <pre> elements
        const isPre = container.tagName.toLowerCase() === 'pre';
        const text = extractTextWithSpaces(container, excludedForContainerText);
        if (!text && !isPre) continue; // allow empty pre if it has interactives? Rare, but okay.

        const rect = container.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        const bottom = rect.bottom + window.scrollY;
        const height = rect.height;

        // Skip if entirely outside rendered range
        if (renderHeight !== null && (bottom < scrollY || top > scrollY + renderHeight)) continue;

        // Skip containers that are significantly taller than rendered range (likely layout wrappers)
        // Disabled, reactivate later if needed. New container selection seems to make it obsolete
        // if (renderHeight !== null && height > renderHeight * 5) continue;

        const containerInteractives = allInteractives.filter(item =>
          container.contains(item.el) && !usedInteractives.has(item.el)
        );
        containerInteractives.forEach(item => usedInteractives.add(item.el));

        results.push({
          type: 'container',
          text,
          interactives: containerInteractives,
          y: top,
          tag: container.tagName.toLowerCase(),
          isHeading: /^H[1-6]$/.test(container.tagName),
          headingLevel: container.tagName.match(/^H(\d)$/)?.[1] || null,
          isPre: isPre
        });
      }

      // Semantic Tables
      renderLog('Processing Semantic Tables');
      const allTables = Array.from(document.querySelectorAll('table'));
      for (const table of allTables) {
        // Do not render layout tables like on Hacker News
        if (table.getAttribute('border') === '0' &&
            table.getAttribute('cellpadding') === '0' &&
            table.getAttribute('cellspacing') === '0') {
          continue;
        }
        if (!hasPointerEvents(table)) continue;
        const top = table.getBoundingClientRect().top + window.scrollY;
        if (renderHeight !== null && (top < scrollY || top > scrollY + renderHeight)) continue;

        const tableData = parseTableStructure(table);


        // ✅ Embed references inline in table cells (clean version)
        for (const row of tableData.rows) {
          for (const cell of row) {
            if (cell?.interactives?.length > 0) {
              let text = cell.text;

              for (const rawEl of cell.interactives) {
                const item = allInteractives.find(i => i.el === rawEl);
                ({ text, refId } = embedInteractiveRef(text, item, elementMap, refId, {fallbackAppend: true}));
              }
              cell.text = text;
            }
          }
        }

        const tableInteractives = allInteractives.filter(item =>
          table.contains(item.el) && !usedInteractives.has(item.el)
        );
        tableInteractives.forEach(item => usedInteractives.add(item.el));

        results.push({
          type: 'table',
          y: top,
          data: tableData,
          interactives: tableInteractives,
          selector: buildSimpleSelector(table),
          caption: table.querySelector('caption')?.innerText.trim() || null
        });
      }

      // Orphans
      renderLog('Processing Orphan Elements');
      for (const item of allInteractives) {
        if (!usedInteractives.has(item.el)) {
          const parentForm = item.el.closest('form');
          const parentContainer = parentForm || item.el.parentElement;
          results.push({
            type: 'container',
            text: item.text,
            interactives: [item],
            y: item.y,
            tag: parentContainer?.tagName.toLowerCase() || 'div',
            isHeading: false,
            headingLevel: null,
            isOrphanInteractive: true
          });
        }
      }

      // Deduplicate, but preserve all tables
      renderLog('Deduplicating results');
      const unique = [];
      for (const item of results) {
        // Always include tables — never deduplicate them
        if (item.type === 'table') {
          unique.push(item);
          continue;
        }

        const isDuplicate = unique.some(u => {
          // Skip comparison with tables
          if (u.type === 'table') return false;

          // For containers/orphans: same text, vertical proximity, same link
          const sameText = u.text === item.text;
          const closeVertically = Math.abs(u.y - item.y) < 50;
          const sameLink = u.interactives[0]?.href === item.interactives[0]?.href;
          return sameText && closeVertically && sameLink;
        });

        if (!isDuplicate) unique.push(item);
      }

      renderLog(`Rendering Markdown (Total items: ${unique.length})`);

      // Final render inside browser
      let markdown = '';

      for (const p of unique.sort((a, b) => a.y - b.y)) {
        if (p.isHeading && p.text) {
          const level = Math.min(6, p.headingLevel || 2);
          markdown += `\n${'#'.repeat(level)} `;
        }

        // Keep <pre> blocks formatted
        if (p.isPre && p.text) {
          const codeText = p.text
            .replace(/[`\\]/g, '\\$1') // escape backticks & backslashes only
            .replace(/\u00A0/g, ' ');   // normalize whitespace, but keep \n

          markdown += `\n\`\`\`\n${codeText}\n\`\`\`\n\n`;
          continue; // ✅ skip paragraph rendering for code blocks
        }

                // ── Render Lists ────────────────────────────────────────────────────────
        if (p.type === 'list') {
          const { isOrdered, items } = p.data;
          const renderedItems = [];

          for (let i = 0; i < items.length; i++) {
            let text = escapeForLLM(items[i].text || '');
            if (!text) continue;

            // Embed interactives inside this list item
            if (items[i].interactives.length > 0) {
              for (const intItem of items[i].interactives) {
                ({ text, refId } = embedInteractiveRef(text, intItem, elementMap, refId, { fallbackAppend: true }));
              }
            }

            const cleaned = text.replace(/\s+/g, ' ').trim();
            if (cleaned) {
              renderedItems.push(isOrdered ? `${i + 1}. ${cleaned}` : `- ${cleaned}`);
            }
          }

          if (renderedItems.length > 0) {
            markdown += renderedItems.join('\n') + '\n\n';
          }
          continue;
        }


        if (p.type === 'table') {
          markdown += renderTableLLMOptimized(p.data);

          if (p.caption) markdown += `\n\n*Caption: ${escapeForLLM(p.caption)}*`;
          markdown += '\n\n';
          continue;
        }

        if (p.isOrphanInteractive && p.interactives.length > 0) {
          for (const item of p.interactives) {
            if (['div', 'span', 'section'].includes(item.tag)) continue;
            if (!item.text?.trim()) continue;

            const ref = refId++;
            elementMap[ref] = createElementMapEntry(ref, item);

            let display = `${item.text}@@REF${ref}@@`;
            if (item.tag === 'input' && (item.type === 'submit' || item.type === 'button')) {
              display = `[${item.text}]@@REF${ref}@@`;
            }
            markdown += `${display}\n\n`;
          }
          continue;
        }

        // ── Standard paragraph with embedded references ────────────────────────
        let text = escapeForLLM(p.text || '');
        if (!text) continue;

        if (p.interactives.length > 0) {

          for (const item of p.interactives) {
            ({ text, refId } = embedInteractiveRef(text, item, elementMap, refId));
          }

          // ── Append unmatched form field refs (inputs, buttons, selects) ──
          if (p.interactives.length > 0) {
            // Track which refs were already embedded via regex
            const embeddedRefs = new Set(
              (text.match(/\[(\d+)\]/g) || []).map(s => parseInt(s.slice(1, -1)))
            );

            const FORM_TAGS = ['input', 'button', 'select', 'textarea'];

            for (const item of p.interactives) {
              const ref = Object.entries(elementMap).find(
                ([, elData]) => elData.selector === item.selector
              )?.[0];

              if (ref && !embeddedRefs.has(parseInt(ref)) && FORM_TAGS.includes(item.tag)) {
                text += ` ${item.text}@@REF${ref}@@ `;
              }
            }
          }
        }

        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (cleaned) markdown += cleaned + '\n\n';
      }

      // Final global replace for embedded references:
      markdown = markdown.replace(/@@REF(\d+)@@/g, '<$1>');

      // After all refs are embedded and markdown built...
      // Post-process elementMap to truncate safely:
      for (const [refId, element] of Object.entries(elementMap)) {
        element.text = element.text ? truncateText(element.text, 80) : '';
      }

      const fullHeight = document.documentElement.scrollHeight;

      renderLog('Render complete');

      return {
        view: markdown.trim(),
        elements: elementMap,
        meta: {
          scrollY,
          renderHeight: renderHeight ?? fullHeight,
          fullHeight,
          totalRefs: refId - 1,
          url: location.href,
          title: document.title
        },
        logs: browserLogs.join('\n') // <--- Return the collected logs
      };
    },
    { scrollY, renderHeight }
  );

  return result;
}

// Export
module.exports = { renderMarkdown };
