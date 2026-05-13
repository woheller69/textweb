/**
 * TextWeb Markdown Renderer v2.6 — Fully browser-safe with Synchronous Logging
 * Renders page to Markdown + element map entirely in browser context.
 */

/**
 * Renders the current page to a Markdown string and a map of interactive elements.
 * Uses browser-native accessibility checks and viewport clipping to extract only visible content.
 *
 * @param {import('playwright').Page} page - Playwright Page instance (must be attached to a live page)
 * @param {Object} options - Rendering options
 * @param {number} [options.scrollY=window.scrollY] - Vertical scroll position (in document pixels)
 * @param {number|null} [options.renderHeight=null] - Max vertical range to render (null = full page)
 * @returns {Promise<Object>} Render result:
 *   - view {string} – Markdown-formatted content
 *   - elements {Record<number, InteractiveElement>} – Map of interactive elements keyed by sequential ref ID
 *   - meta {Object} – Metadata: scrollY, renderHeight, fullHeight, totalRefs, url, title
 *   - logs {string} – Collected browser-side logs
 *
 * @example
 * const result = await renderMarkdown(page, { scrollY: 0, renderHeight: 2000 });
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
       * Determines whether a DOM element's bounding rectangle is *entirely* outside
       * the currently rendered vertical viewport.
       *
       * The rendered viewport is defined as the interval `[scrollY, scrollY + renderHeight)`.
       * If `renderHeight === null`, no clipping is applied and the function always returns `false`.
       *
       * ✅ Handles elements that straddle the top or bottom edge of the viewport — only returns `true`
       *    when the element has *zero vertical overlap* with the rendered region.
       *
       * ⚠️ Requires `rect` to be a `DOMRect`/`DOMRectReadOnly` obtained from `element.getBoundingClientRect()`.
       *    (Note: `rect.top` and `rect.bottom` are viewport-relative, so we add `window.scrollY` to get document coordinates.)
       *
       * @param {DOMRect | DOMRectReadOnly} rect - Bounding rectangle of the element (from `getBoundingClientRect()`).
       * @returns {boolean} `true` if the element is completely above or below the rendered region, `false` otherwise.
       *
       * @example
       * // Usage in rendering loop:
       * const rect = element.getBoundingClientRect();
       * if (isOutsideRenderedRange(rect)) {
       *   continue; // Skip rendering this element — it's not visible
       * }
       *
       * @see renderMarkdown — where `renderHeight` and `scrollY` are set via Playwright options.
       */
      function isOutsideRenderedRange(rect) {
        const top = rect.top + window.scrollY;
        const bottom = rect.bottom + window.scrollY;

        return renderHeight !== null && (bottom < scrollY || top > scrollY + renderHeight);
      }

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

      const INCLUDED_SELECTORS = ['p', 'figcaption', 'dt', 'dd', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'pre'];

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
       * Checks if an element is *visually and functionally* visible to users (per layout heuristics).
       * Includes ancestor-level checks for `display:none`, `overflow:hidden` clipping, transforms, etc.
       * Also checks AX-hidden, disabled state, and CSS/rect constraints.
       *
       * This function *walks ancestors* to detect full layout invisibility.
       *    Use this for DOM traversal pruning (e.g., skip hidden menus/accordions).
       *
       * @param {Element} el - DOM element to inspect
       * @returns {boolean} `true` if element is visually and functionally visible
       */
      function isVisibleInLayout(el) {
        if (!el || !el.nodeType || el.nodeType !== Node.ELEMENT_NODE) return false;

        // 1. Quick exits for common ARIA/HTML attributes
        if (el.hasAttribute('hidden')) return false;
        if (el.closest('[aria-hidden="true"]')) return false;
        if (el.getAttribute('aria-disabled') === 'true') return false;
        if (el.closest('[inert]')) return false;

        // 2. Immediate element-level checks
        const style = getComputedStyle(el);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          parseFloat(style.opacity) === 0 ||
          style.pointerEvents === 'none'
        ) {
          return false;
        }

        // Check rect size early (avoids ancestor walk if element itself is zero-size)
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;

        // Legacy clip checks
        if (
          style.getPropertyValue('clip-path')?.includes('rect(0px 0px 0px 0px)') ||
          style.clip === 'rect(0px, 0px, 0px, 0px)'
        ) {
          return false;
        }

        // 3. Ancestor walk (with performance optimization)
        let ancestor = el.parentElement;
        while (ancestor) {
          // Stop at document root
          if (ancestor.tagName.toLowerCase() === 'html') break;

          const aStyle = getComputedStyle(ancestor);

          // A. Ancestor is fully hidden
          if (
            aStyle.display === 'none' ||
            aStyle.visibility === 'hidden' ||
            parseFloat(aStyle.opacity) === 0
          ) {
            return false;
          }

          // B. Overflow clipping
          if (
            aStyle.overflow === 'hidden' ||
            aStyle.overflowY === 'hidden' ||
            aStyle.overflowX === 'hidden'
          ) {
            const aRect = ancestor.getBoundingClientRect();
            // Re-get rect in case layout shifted? No, getBoundingClientRect is live.
            // But we already have `rect` from above. Ensure it's still valid.
            const elRect = el.getBoundingClientRect();

            // Check if el is fully outside ancestor's clipped area
            if (
              elRect.top >= aRect.bottom ||
              elRect.bottom <= aRect.top ||
              elRect.right <= aRect.left ||
              elRect.left >= aRect.right
            ) {
              return false;
            }
          }

          // C. Transform check (only if transform is non-trivial)
          const transform = aStyle.transform;
          if (transform && transform !== 'none') {
            // Optional: Add more sophisticated matrix analysis if needed
            // For now, rely on window bounds check
            const elRect = el.getBoundingClientRect();
            if (
              elRect.bottom < 0 ||
              elRect.top > window.innerHeight ||
              elRect.right < 0 ||
              elRect.left > window.innerWidth
            ) {
              return false;
            }
          }

          ancestor = ancestor.parentElement;
        }

        return true;
      }

      /**
       * Determines whether a DOM element is *functionally interactive* — i.e., likely triggers navigation or UI actions.
       * Checks standard interactive tags (A, BUTTON, etc.), ARIA roles/attributes, explicit tabindex, and behavioral clues
       * (onclick, aria-expanded/pressed/checked). Note: does NOT treat SPAN as interactive by default unless it has onclick/ARIA.
       *
       * @param {Element} el - DOM element to inspect
       * @returns {boolean} true if element is likely interactive to users (e.g., clickable, focusable, or state-changing)
       */
      function isInteractiveElement(el) {
        // 1. Standard interactive tags
        const standardTags = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'];
        if (standardTags.includes(el.tagName)) return true;

        // 2. ARIA roles (this covers SPAN/DIV with role="button")
        const role = (el.getAttribute('role') || '').toLowerCase();
        const interactiveRoles = ['button', 'link', 'tab', 'checkbox', 'radio', 'slider', 'switch', 'menuitem', 'treeitem', 'gridcell', 'row'];
        if (interactiveRoles.includes(role)) return true;

        // 3. Explicit tabindex (skip -1)
        if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1') return true;

        // 4. Behavioral clues (for SPAN/DIV)
        // Check if it has an inline onclick or is a common clickable pattern
        const hasOnClick = el.hasAttribute('onclick');
        const hasAriaState = ['aria-expanded', 'aria-pressed', 'aria-checked', 'aria-selected', 'aria-haspopup'].some(attr => el.hasAttribute(attr));

        if (hasOnClick || hasAriaState) return true;

        return false;
      }

      /**
       * Helper: check if an href is meaningful for deduplication.
       * Excludes #, javascript:, mailto:, tel:, empty strings.
       */
      function isUsefulHref(href) {
        return href &&
          href !== '#' &&
          !href.startsWith('javascript:') &&
          !href.startsWith('mailto:') &&
          !href.startsWith('tel:') &&
          href.trim() !== '';
      }

      /**
       * Create a standardized element map entry for an interactive item.
       * Used to populate the `elements` object returned in render result.
       *
       * ✅ NEW: Link deduplication — if this is a link and href already exists,
       *         returns the existing refId instead of incrementing.
       *         Otherwise: allocates new refId and returns it.
       *
       * @param {Object} item - Element data with properties like tag, selector, href, text, etc.
       * @param {Object} elementMap - Mutable map to register the ref entry
       * @returns {number} refId — either reused or newly allocated
       */
      function createElementMapEntry(item, elementMap) {
        const tag = item.tag;
        const type = item.type;

        // 🔍 Deduplicate links by href: check if same href already in elementMap
        if (tag === 'a' && isUsefulHref(item.href)) {
          for (const [existingRefIdStr, existingEntry] of Object.entries(elementMap)) {
            if (
              existingEntry.tag === 'a' &&
              existingEntry.href === item.href
            ) {
              renderLog(`Reusing refId ${existingRefIdStr} for link "${item.href}"`);
              return Number(existingRefIdStr);
            }
          }
        }

        // No duplicate — allocate new ID

        const refIdNum = Object.keys(elementMap).length;
        elementMap[refIdNum] = {
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
          disabled: !!item.disabled || item.el?.getAttribute('aria-disabled') === 'true',
          checked: tag === 'input' && ['checkbox', 'radio'].includes(type) ? item.checked || null : null,
          selected: tag === 'select' ? item.selected || null : null,
          required: !!item.required,
          value: item.value || null,
          placeholder: item.placeholder || null,
          name: item.name || null,
          type: type || null,
          refId: refIdNum // ✅ include refId for traceability
        };

        renderLog(`Assigned refId ${refIdNum} for ${tag} "${item.text?.substring(0, 20)}${item.text?.length > 20 ? '...' : ''}"`);
        return refIdNum;
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
            headers.push(normalizeTableCellText(decodeHTML(extractTextWithSpaces(cell))));
          });
        }

        // Extract body rows from .tableBody
        const tableBody = tableContainer.querySelector('.tableBody');
        if (tableBody) {
          const bodyRows = Array.from(tableBody.querySelectorAll('.row'));

          bodyRows.forEach(rowEl => {
            const cells = Array.from(rowEl.querySelectorAll('.column'));
            const rowData = cells.map(cell => {
              const text = normalizeTableCellText(decodeHTML(extractTextWithSpaces(cell)))
              const interactives = Array.from(
                cell.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]')
              ).filter(el => isVisibleInLayout(el) && isInteractiveElement(el));

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
          if (!isVisibleInLayout(li)) continue;

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
          ).filter(el => isVisibleInLayout(el) && isInteractiveElement(el));

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

          // Skip invisible text (use `isVisibleInLayout` on parent, not `getComputedStyle`)
          // Note: We only need to guard for `offsetParent === null`, since `display:none` is already pruned
          if (parent.offsetParent === null && getComputedStyle(parent).position !== 'fixed') {
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
       * Normalize text extracted from a *table cell*.
       * - Collapses multiple spaces/newlines/tabs into single space
       * - Trims edges
       * - Does NOT affect <pre>, <code>, or non-cell content
       * @param {string} text
       * @returns {string}
       */
      function normalizeTableCellText(text) {
        if (!text) return '';
        return text
          .replace(/[\t\n\r]+/g, ' ')  // tabs/newlines → space
          .replace(/\s+/g, ' ')         // multiple spaces → single space
          .trim();
      }


      /**
       * Parse HTML table structure into headers and rows with interactive references.
       * Handles colspan/rowspan generically — respects multi-column headers *and* multi-column rows.
       * @param {Element} table - Table DOM element
       * @returns {{ headers: string[], rows: CellData[][] }} Parsed table data
       */
      function parseTableStructure(table) {
        renderLog('Parsing semantic table structure', table.tagName);
        const headers = [];
        const rows = [];

        const firstRow = table.querySelector('tr');
        if (!firstRow) return { headers: [], rows: [] };

        // ── STEP 1: Determine max columns by scanning *all rows* for colspan ──
        const tbody = table.querySelector('tbody') || table;
        const trs = Array.from(tbody.children).filter(el => el.tagName === 'TR');

        let maxCols = 0;
        trs.forEach((tr, rowIndex) => {
          const cols = Array.from(tr.children).filter(el => el.tagName === 'TD' || el.tagName === 'TH');
          let colCount = 0;
          cols.forEach(cell => {
            const colspan = parseInt(cell.colSpan, 10) || 1;
            const rowspan = parseInt(cell.rowSpan, 10) || 1;
            colCount += colspan;
            // Skip next (rowspan-1) rows for this cell's column
            for (let r = 1; r < rowspan; r++) {
              if (!trs[rowIndex + r]) continue;
              // Mark cell as spanning — but don't increment colCount
            }
          });
          if (colCount > maxCols) maxCols = colCount;
        });

        // ── STEP 2: Parse headers (if <th>) ──
        const hasTh = firstRow.querySelector('th') !== null;

        if (hasTh) {
          // ✅ Fix: Expand headers respecting colspan
          const headerCells = Array.from(firstRow.querySelectorAll('th'));
          const expandedHeaders = new Array(maxCols).fill('');

          let colIndex = 0;
          headerCells.forEach(cell => {
            const colspan = parseInt(cell.colSpan, 10) || 1;
            const text = normalizeTableCellText(decodeHTML(extractTextWithSpaces(cell)));
            // Fill first header slot with real text, others empty
            expandedHeaders[colIndex] = text;
            // Advance colIndex by colspan
            colIndex += colspan;
          });
          headers.push(...expandedHeaders);
        }

        // ── STEP 3: Parse rows — expand cells for colspan, store metadata ──
        const cellMap = [];

        trs.forEach((tr, rowIndex) => {
          const cols = Array.from(tr.children).filter(el => el.tagName === 'TD' || el.tagName === 'TH');
          let colIndex = 0;

          if (!cellMap[rowIndex]) cellMap[rowIndex] = [];

          cols.forEach(cell => {
            const colspan = parseInt(cell.colSpan, 10) || 1;
            const rowspan = parseInt(cell.rowSpan, 10) || 1;
            const text = normalizeTableCellText(decodeHTML(extractTextWithSpaces(cell)));
            const interactives = Array.from(
              cell.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"]')
            ).filter(el => isVisibleInLayout(el) && isInteractiveElement(el));

            // Store main cell at current colIndex
            cellMap[rowIndex][colIndex] = {
              text,
              interactives,
              colSpan: colspan,
              rowSpan: rowspan,
              selector: buildSimpleSelector(cell),
              tag: cell.tagName.toLowerCase()
            };

            // Fill subsequent columns (colspan-1) as "spanned"
            for (let c = 1; c < colspan; c++) {
              const targetCol = colIndex + c;
              if (!cellMap[rowIndex]) cellMap[rowIndex] = [];
              while (cellMap[rowIndex].length <= targetCol) cellMap[rowIndex].push(null);
              cellMap[rowIndex][targetCol] = { text: '', interactives: [], isSpan: true, spanFrom: 'col' };
            }

            // Handle rowspan
            for (let r = 1; r < rowspan; r++) {
              const targetRow = rowIndex + r;
              if (!cellMap[targetRow]) cellMap[targetRow] = [];
              while (cellMap[targetRow].length <= colIndex) cellMap[targetRow].push(null);
              cellMap[targetRow][colIndex] = {
                text: '',
                interactives: [],
                isSpan: true,
                spanFrom: 'row',
                spanFromRow: rowIndex,
                spanFromCol: colIndex,
                spanValue: text,
                spanInteractives: interactives
              };
            }

            colIndex += colspan;
          });
        });

        // ── STEP 4: Convert cellMap → rows (ensuring all rows have maxCols) ──
        cellMap.forEach((rowCells, rowIndex) => {
          if (!rowCells) return;

          // Pad row to maxCols (if needed)
          while (rowCells.length < maxCols) {
            rowCells.push({ text: '', interactives: [], colSpan: 1, rowSpan: 1 });
          }

          rows.push(rowCells.map(cell => {
            if (cell?.isSpan) {
              return {
                text: cell.spanValue || cell.text || '',
                interactives: cell.spanInteractives || cell.interactives || [],
                colSpan: cell.colSpan || 1,
                rowSpan: cell.rowSpan || 1,
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

        // Skip if hidden from AX tree
        if (el.closest('[aria-hidden="true"]')) return '';
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
              if (!parent) return NodeFilter.FILTER_REJECT;

              // Skip invisible or AX-hidden ancestors
              if (parent.closest('[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
              // Skip invisible text
              // (Still check offsetParent for non-fixed positioned elements as fallback)
              if (parent.offsetParent === null && getComputedStyle(parent).position !== 'fixed') {
                return NodeFilter.FILTER_SKIP;
              }

              // Skip if inside any excluded selector (NEW)
              for (const sel of excludedSelectors) {
                // Check if *any ancestor* matches the selector
                if (parent.closest?.(sel)) return NodeFilter.FILTER_REJECT; // Reject this subtree entirely
              }

              return NodeFilter.FILTER_ACCEPT;
            }
          }
        );

        const parts = [];
        let node;
        while ((node = walker.nextNode())) {
          const text = node.textContent;
          if (text.trim()) parts.push(text);
        }

        return parts.length === 0 ? '' : parts.join(' ').trim();
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
       * Embeds a reference placeholder (e.g., `@@REF5@@`) into `targetText` by matching `item.text`.
       * Registers the interactive element in `elementMap`, reusing existing IDs for duplicate links.
       *
       * ⚠️ Side effect: Mutates `elementMap` immediately — do not rely on ID values until post-processing (see bottom of render loop).
       *
       * @param {string} targetText - Text to modify
       * @param {Object} item - Interactive element data (must have `.text`, `.el`, `.tag`, etc.)
       * @param {Object} elementMap - Mutable map of interactive elements
       * @param {Object} [options] - Options
       * @param {boolean} [options.fallbackAppend=false] - Append reference even on no-match
       * @returns {{text: string, matched: boolean}} Updated text + match status
       */
      function embedInteractiveRef(targetText, item, elementMap, { fallbackAppend = false } = {}) {
        if (!item || !item.text?.trim()) {
          return { text: targetText, matched: false };
        }

        const refId = createElementMapEntry(item, elementMap);
        const placeholder = `@@REF${refId}@@`;

        // ✅ Normalize both strings for reliable matching
        const normItem = item.text.replace(/[\u00A0\s]+/g, ' ').trim().toLowerCase();
        const normTarget = targetText.replace(/[\u00A0\s]+/g, ' ').trim().toLowerCase();

        // 1️⃣ Exact match (common for full-heading links or button labels)
        if (normTarget === normItem) {
          return { text: `${targetText}${placeholder}`, matched: true };
        }

        // 2️⃣ Boundary-aware regex
        const safeText = normItem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const regex = new RegExp(`(^|[\\s(\\[<\\*\\_])(${safeText})([\\s.:;,!?)\\]>\\*\\_]|$)`, 'i');

        if (regex.test(normTarget)) {
          // $1, $2, $3 automatically capture from original targetText → preserves case & formatting
          targetText = targetText.replace(regex, '$1$2' + placeholder + '$3');
          return { text: targetText, matched: true };
        }

        // Fallback append (if enabled)
        if (fallbackAppend) {
          targetText = `${targetText} ${placeholder}`;
        }

        return { text: targetText, matched: false };
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

      let elementMap = {};
      // 1. Collect interactives
      renderLog('Scanning interactive elements...');
      const allInteractives = [];
      document.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
      ).forEach(el => {
        for (const selector of EXCLUDED_SELECTORS) {
            if (el.closest(selector)) return;
        }
        if (!isVisibleInLayout(el) || !isInteractiveElement(el)) return;

        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        if ((isOutsideRenderedRange(rect))) return;

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

      const allContainers = Array.from(document.querySelectorAll(INCLUDED_SELECTORS.join(', ')));
      const filteredContainers = [];

      // Optimization: Create a Set of all elements we are interested in for O(1) lookups
      const includedSelectorSet = new Set(allContainers);

      for (const el of allContainers) {
        // --- STEP 1: LEAF-NODE STRATEGY (Prevent Text Duplication) ---
        // We only want the "deepest" elements. If this element contains
        // another element that is ALSO in our INCLUDED_SELECTORS, we skip this one.
        // This prevents a <div> containing a <p> from being rendered twice.

        const descendants = el.querySelectorAll(INCLUDED_SELECTORS.join(', '));
        if (descendants.length > 0) {
          continue;
        }

        // --- STEP 2: VISIBILITY CHECK ---
        if (!isVisibleInLayout(el)) {
          continue;
        }

        // --- STEP 3: SEMANTIC EXCLUSIONS ---
        const tagName = el.tagName.toLowerCase();

        // 3a. Exclude semantic tables
        if (tagName === 'table') {
          continue;
        }

        // 3b. Exclude div-based tables
        if (tagName === 'div') {
          let isDivTable = false;
          for (const selector of TABLE_SELECTORS) {
            if (el.matches(selector) || el.closest(selector)) {
              isDivTable = true;
              break;
            }
          }
          if (isDivTable || el.querySelector('table')) {
            continue;
          }
        }

        // 3c. Exclude known unwanted areas (ads, nav, etc.)
        let isExcluded = false;
        for (const selector of EXCLUDED_SELECTORS) {
          if (el.closest(selector)) {
            isExcluded = true;
            break;
          }
        }
        if (isExcluded) continue;

        // 3d. Skip containers inside semantic tables
        if (el.closest('table')) {
          continue;
        }

        // 3e. Skip empty wrapper containers
        if (tagName === 'div' || tagName === 'section') {
          const textWithoutListsTables = extractTextWithSpaces(el, [
            ...LIST_SELECTORS,
            ...TABLE_SELECTORS
          ]);

          if (!textWithoutListsTables.trim()) {
            continue;
          }
        }

        // --- STEP 4: SUCCESS ---
        // If we reached here, the element is a visible, non-table, non-excluded,
        // non-parent leaf node.
        filteredContainers.push(el);
      }




      // ── Process Lists (Independent of INCLUDED_SELECTORS) ─────────────────────
      renderLog('Processing Lists');

      const allLists = Array.from(document.querySelectorAll(LIST_SELECTORS.join(', ')))
        .filter(list => {
          // ✅ NEW: Skip lists inside tables — treat them as inline content
          if (list.closest('table')) {
            renderLog(`Skipping list ${list.className || list.tagName} inside table`);
            return false;
          }

          // ✅ NEW: Skip lists inside EXCLUDED_SELECTORS (e.g., .devsite-nav-item)
          for (const selector of EXCLUDED_SELECTORS) {
            if (list.closest(selector)) {
              renderLog(`Skipping list inside ${selector}: ${list.className || list.tagName}`);
              return false;
            }
          }

          return isVisibleInLayout(list);
        });

      for (const listEl of allLists) {
        const rect = listEl.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        // Respect render height filtering
        if (isOutsideRenderedRange(rect)) continue;

        const listData = parseListStructure(listEl);
        if (listData.items.length === 0) continue;

        // Embed interactive references inline in list items
        for (const item of listData.items) {
          for (const rawEl of item.interactives) {
            const interactiveItem = allInteractives.find(i => i.el === rawEl);
            if (interactiveItem) {
              let text = item.text;
              ({ text } = embedInteractiveRef(text, interactiveItem, elementMap, { fallbackAppend: true }));
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
        .filter(tc => isVisibleInLayout(tc));

      for (const tableContainer of allDivTableContainers) {
        if (processedDivTables.has(tableContainer)) continue;
        processedDivTables.add(tableContainer);

        const rect = tableContainer.getBoundingClientRect();
        const top = rect.top + window.scrollY;

        // Rendered range filtering
        if (isOutsideRenderedRange(rect)) continue;

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
                  ({ text } = embedInteractiveRef(text, item, elementMap, { fallbackAppend: true }));
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
        if (!isVisibleInLayout(container)) continue;
          // 👇 NEW: Detect and mark <pre> elements
        const isPre = container.tagName.toLowerCase() === 'pre';
        const text = extractTextWithSpaces(container, excludedForContainerText);
        if (!text && !isPre) continue; // allow empty pre if it has interactives? Rare, but okay.

        const rect = container.getBoundingClientRect();
        const top = rect.top + window.scrollY;

        // Skip if entirely outside rendered range
        if ((isOutsideRenderedRange(rect))) continue;

        // Skip containers that are significantly taller than rendered range (likely layout wrappers)
        // Disabled, reactivate later if needed. New container selection seems to make it obsolete
        // if (renderHeight !== null && height > renderHeight * 5) continue;

        const containerInteractives = allInteractives.filter(item =>
          container.contains(item.el) && !usedInteractives.has(item.el)
        );
        containerInteractives.forEach(item => usedInteractives.add(item.el));

        const left = rect.left + window.scrollX;

        results.push({
          type: 'container',
          text,
          interactives: containerInteractives,
          y: top,
          x: left,
          tag: container.tagName.toLowerCase(),
          isHeading: /^H[1-6]$/.test(container.tagName),
          headingLevel: container.tagName.match(/^H(\d)$/)?.[1] || null,
          isPre: isPre,
          isPartOfDivTable: false // ← add this
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
       if (!isVisibleInLayout(table)) continue;
        const rect = table.getBoundingClientRect();
        const top = rect.top + window.scrollY;

        if (isOutsideRenderedRange(rect)) continue;

        const tableData = parseTableStructure(table);


        // ✅ Embed references inline in table cells (clean version)
        for (const row of tableData.rows) {
          for (const cell of row) {
            if (cell?.interactives?.length > 0) {
              let text = cell.text;

              for (const rawEl of cell.interactives) {
                const item = allInteractives.find(i => i.el === rawEl);
                ({ text } = embedInteractiveRef(text, item, elementMap, {fallbackAppend: true}));
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
      // Use a Map to store fingerprints: key = hash(text + y + link), value = true
      const seenFingerprints = new Set();

      for (const item of results) {
        // Always include all tables
        if (item.type === 'table') {
          unique.push(item);
          continue;
        }

        // Create a unique fingerprint for the item
        // We combine text, vertical position (rounded to 10px to allow slight shifts), and the primary link
        const textKey = (item.text || '').trim().toLowerCase();
        const yKey = Math.round(item.y / 20) * 20;
        const linkKey = item.interactives[0]?.href || '';
        const fingerprint = `${textKey}|${yKey}|${linkKey}`;

        if (!seenFingerprints.has(fingerprint)) {
          seenFingerprints.add(fingerprint);
          unique.push(item);
        } else {
          renderLog(`Skipping duplicate item: ${textKey.substring(0, 20)}`);
        }
      }

      renderLog(`Rendering Markdown (Total items: ${unique.length})`);

      // ─── DETECT & RENDER TABLES FROM CONTAINER CLUSTERS ──────────────────────────────────
      // Step 1: Group containers by exact y (not rounded!) to find column groups
      const yGroups = {};
      for (const item of unique) {
        if (item.type === 'container' && item.y != null) {
          const y = Math.floor(item.y);
          if (!yGroups[y]) yGroups[y] = [];
          yGroups[y].push(item);
        }
      }

      renderLog(`Found ${Object.keys(yGroups).length} unique y positions for containers`);

      // Find groups that could be table columns (≥4 items = typical 4-column layout)
      const potentialRows = [];
      for (const [yStr, group] of Object.entries(yGroups)) {
        if (group.length >= 4) {
          const sorted = [...group].sort((a, b) => a.x - b.x); // sort by x to get column order
          potentialRows.push(sorted);
          renderLog(`Potential column group at y=${yStr}: ${group.length} items, xs=[${sorted.map(c=>Math.round(c.x)).join(', ')}]`);
        }
      }

      // ─── DETECT TABLES WITH FLEXIBLE Y-GAP ───────────────────────────────────────────
      const detectedTables = [];
      const processedLayouts = new Set();

      for (const row of potentialRows) {
        const layoutKey = row.map(c => Math.round(c.x)).join('|');
        if (processedLayouts.has(layoutKey)) continue;
        processedLayouts.add(layoutKey);

        const firstY = row[0].y;
        const firstXs = row.map(c => Math.round(c.x));

        // Scan forward for rows with same layout
        const tableRows = [row];
        let prevY = firstY;

        // Scan all y groups (removed 400px limit)
        for (const [yStr, group] of Object.entries(yGroups)) {
          const y = Number(yStr);
          if (y <= prevY) continue;

          // Allow larger gaps (e.g., 100px), but skip if too large (likely a new section)
          const deltaY = y - prevY;
          if (deltaY > 100) continue;

          if (group.length !== row.length) continue;

          const candidateRow = [...group].sort((a, b) => a.x - b.x);
          const candidateXs = candidateRow.map(c => Math.round(c.x));

          // Check alignment: same #cols, same x positions (±5px)
          const aligned = candidateXs.every((x, i) => Math.abs(x - firstXs[i]) <= 5);

          if (aligned) {
            // Consider this a continuation of the table
            tableRows.push(candidateRow);
            prevY = y;
          }
          for (const row of tableRows) {
            for (const cell of row) {
              cell.isPartOfDivTable = true; // ← add this
            }
          }
        }

        // Commit if ≥2 rows
        if (tableRows.length >= 2) {
          renderLog(`✅ Detected div-based table: ${tableRows.length} rows × ${row.length} cols at y=${firstY}`);

          // Embed interactives directly into cell text
          const rows = tableRows.map((row, rowIndex) => {
            return row.map(cell => {
              let cellText = cell.text || '';
              const interactives = [...cell.interactives];

              // Embed references for each interactive
              for (const item of interactives) {
                const { text: updatedText } = embedInteractiveRef(
                  cellText,
                  item,
                  elementMap,
                  { fallbackAppend: false } // no fallback — we want it embedded
                );
                cellText = updatedText;
              }

              return {
                text: normalizeTableCellText(cellText),
                interactives: []
              };
            });
          });

          // MARK AS USED — prevents double-embedding in orphans
          const tableInteractives = tableRows.flat().map(c => c.interactives).flat();
          for (const item of tableInteractives) {
            usedInteractives.add(item.el);
          }

          const tableData = {
            headers: [], // force all rows as body
            rows: rows
          };

          detectedTables.push({
            type: 'table',
            y: firstY,
            data: tableData,
            interactives: [], // already embedded
            selector: 'div[data-detect="div-table"]'
          });

          renderLog(`Embedded refs in ${tableRows.length} rows`);
        }
      }

      // Remove leaf containers that are part of detected tables
      const rowsToRemoveSet = new Set();
      if (detectedTables.length > 0) {
        for (const table of detectedTables) {
          for (const row of table.data.rows) {
            for (const cell of row) {
              for (const item of unique) {
                if (item.type === 'container' && item.text?.trim() === cell.text?.trim()) {
                  rowsToRemoveSet.add(item);
                }
              }
            }
          }
        }
      }

      // Replace: keep only non-table containers + tables
      const uniqueFiltered = unique.filter(item => !rowsToRemoveSet.has(item));
      unique.length = 0;
      unique.push(...detectedTables);
      unique.push(...uniqueFiltered);

      // ─── END TABLE DETECTION ────────────────────────────────────────────────────────────

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

        // ── Render Tables ────────────────────────────────────────────────────────
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

            const refId = createElementMapEntry(item, elementMap);
            let display = `${item.text}@@REF${refId}@@`;
            if (item.tag === 'input' && (item.type === 'submit' || item.type === 'button')) {
              display = `[${item.text}]@@REF${refId}@@`;
            }
            markdown += `${display}\n\n`;
          }
          continue;
        }

        // ── Standard paragraph with embedded references ────────────────────────
        let text = escapeForLLM(p.text || '');
        if (!text) continue;

        if (p.isPartOfDivTable) continue; // ← add this

        if (p.interactives.length > 0) {

          for (const item of p.interactives) {
            ({ text } = embedInteractiveRef(text, item, elementMap));
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

      // Post-process: reassign reference IDs in order of appearance in markdown
      const refMatches = [...markdown.matchAll(/@@REF(\d+)@@/g)].map(m => parseInt(m[1]));

      if (refMatches.length > 0) {
        // 1. Build mapping from old refId → new sequential ID (by first appearance in markdown)
        const refToNewId = {};
        let newId = 1;
        const seen = new Set();
        for (const oldRefId of refMatches) {
          if (!seen.has(oldRefId)) {
            seen.add(oldRefId);
            refToNewId[oldRefId] = newId++;
          }
        }

        // 2. Rebuild elementMap with new sequential IDs
        const reorderedMap = {};
        for (const [oldRefIdStr, element] of Object.entries(elementMap)) {
          const oldRefId = parseInt(oldRefIdStr);
          const newRefId = refToNewId[oldRefId];
          if (newRefId !== undefined) {
            reorderedMap[newRefId] = { ...element, refId: newRefId };
          }
        }

        // 3. Replace placeholders using new sequential IDs
        markdown = markdown.replace(/@@REF(\d+)@@/g, (match, oldRefIdStr) => {
          const oldRefId = parseInt(oldRefIdStr);
          const newRefId = refToNewId[oldRefId];
          return `<${newRefId}>`;
        });

        // 4. Replace elementMap
        elementMap = reorderedMap;
      }


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
          totalRefs: Object.keys(elementMap).length,
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
