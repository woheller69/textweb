/**
 * TextWeb Markdown Renderer v2.2 — Fully browser-safe
 * Renders page to Markdown + element map entirely in browser context.
 */

/**
 * Main export: render entire page
 * @param {Page} page - Playwright Page
 * @param {Object} options - { scrollY, viewportHeight }
 * @returns {Promise<Object>} { view, elements, meta }
 */
async function renderMarkdown(page, options = {}) {
  const { scrollY = 0, viewportHeight = null } = options;

  const result = await page.evaluate(
    ({ scrollY, viewportHeight }) => {
      // ─── ALL HELPER FUNCTIONS (browser context) ─────────────────────────────

      /**
       * Decode HTML entities safely (in-browser)
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
       * Is element visible & interactable?
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
       * Is element an interactive candidate?
       */
      function isInteractiveElement(el) {
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
       * Create a standardized elementMap entry for an interactive item
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
          text: truncateText(item.text),
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
       * Build minimal CSS selector (stable, unique, no :has-text)
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
       * Parse table DOM
       */
      function parseTableStructure(table) {
        const headers = [];
        const rows = [];

        const firstRow = table.querySelector('tr');
        if (!firstRow) return { headers: [], rows: [] };

        const headerCells = firstRow.querySelectorAll('th, td');
        headerCells.forEach((cell) => {
          headers.push(cell.innerText.trim());
        });

        const tbody = table.querySelector('tbody') || table;
        const trs = Array.from(tbody.querySelectorAll('tr'));
        const cellMap = [];

        trs.forEach((tr, rowIndex) => {
          const cols = Array.from(tr.children);
          let colIndex = 0;

          cols.forEach(cell => {
            const { colspan = 1, rowspan = 1 } = cell;
            const text = decodeHTML(cell.innerText.trim());
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
       * Render table to Markdown with alignment
       */
      function getAlignment(headers, rows, colIndex) {
        const values = new Set();
        rows.forEach(row => {
          if (row[colIndex] && row[colIndex].text) {
            const text = row[colIndex].text.trim().replace(/[,$]/g, '');
            if (text && !isNaN(Number(text.replace(/[^\d.\-]/g, '')))) {
              values.add('numeric');
            } else if (text) {
              values.add('text');
            }
          }
        });
        return values.size === 0 ? 'left' : (values.size === 1 && values.has('numeric') ? 'right' : 'left');
      }

      function renderTable(tableData) {
        const { headers, rows } = tableData;
        if (!headers.length && !rows.length) return '';

        const cols = Math.max(headers.length, rows.length ? Math.max(...rows.map(r => r.length)) : 0);
        while (headers.length < cols) headers.push('');
        rows.forEach(row => {
          while (row.length < cols) row.push({ text: '', interactives: [], colSpan: 1, rowSpan: 1 });
        });

        const colWidths = new Array(cols).fill(3);
        headers.forEach((h, i) => colWidths[i] = Math.max(colWidths[i], h.length));
        rows.forEach(row => {
          row.forEach((cell, i) => {
            colWidths[i] = Math.max(colWidths[i], (cell.text || '').length);
          });
        });

        const hRow = '| ' + headers.map((h, i) => h.padEnd(colWidths[i])).join(' | ') + ' |';
        const sepRow = '| ' + colWidths.map((w, i) => {
          const align = getAlignment(headers, rows, i);
          if (align === 'right') return ':' + '-'.repeat(w - 1);
          if (align === 'center') return ':' + '-'.repeat(w - 2) + ':';
          return '-'.repeat(w);
        }).join(' | ') + ' |';
        const bodyRows = rows.map(row =>
          '| ' + row.map((cell, i) => escapeForLLM(cell.text || '').padEnd(colWidths[i])).join(' | ') + ' |'
        );

        return `\n\n${hRow}\n${sepRow}\n${bodyRows.join('\n')}\n`;
      }

      /**
       * Escape text for Markdown + LLM
       */
      function escapeForLLM(str) {
        if (!str) return '';
        str = decodeHTML(str);
        return str
          .replace(/([*_`<>\\|~])/g, '\\$1')
          .replace(/\u00A0/g, ' ')
          .replace(/\n+/g, ' ');
      }

      /**
       * Embed an interactive reference into target text using @@REF_n@@ placeholder.
       * Performs regex matching with word boundaries + delimiters, then replaces match.
       * @param {string} targetText - The text to search/modify
       * @param {Object} item - The interactive item with .text property
       * @param {Object} elementMap - The map to register the ref entry
       * @param {number} refId - Current ref counter
       * @param {Object} options - { fallbackAppend?: boolean }
       * @returns {{ text: string, refId: number, ref: number, matched: boolean }}
       *          Updated text, new refId, assigned ref, and whether regex matched
       */
      function embedInteractiveRef(targetText, item, elementMap, refId, { fallbackAppend = false } = {}) {
        if (!item || !item.text?.trim()) {
          return { text: targetText, refId, ref: null, matched: false };
        }

        const itemText = item.text.trim();
        const ref = refId++;
        const placeholder = `@@REF_${ref}@@`;

        elementMap[ref] = createElementMapEntry(ref, item);

        // Escape for LLM + regex safety
        const escapedItemText = escapeForLLM(itemText);
        const safeText = escapedItemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Boundary-aware regex (matches word + common delimiters)
        const regex = new RegExp(`(^|\\s|[(\\[])(\\b${safeText}\\b)(\\s|[.:;!?)\\]]|$)`, 'i');
        const match = targetText.match(regex);

        if (match) {
          // Preserve surrounding context while injecting placeholder
          targetText = targetText.replace(regex, `${match[1]}${match[2]}${placeholder}${match[3]}`);
          return { text: targetText, refId, ref, matched: true };
        }

        // No match found
        if (fallbackAppend) {
          // Append reference at end as fallback
          targetText = `${targetText}[${ref}]`;
        }

        return { text: targetText, refId, ref, matched: false };
      }

      /**
       * Truncate text for metadata
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
       * Get Playwright action
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
      let refId = 1;
      const elementMap = {};
      // 1. Collect interactives
      const allInteractives = [];
      document.querySelectorAll(
        'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
      ).forEach(el => {
        if (!hasPointerEvents(el) || !isInteractiveElement(el)) return;

        const rect = el.getBoundingClientRect();
        const top = rect.top + window.scrollY;
        if (viewportHeight !== null && (top < scrollY || top > scrollY + viewportHeight)) return;

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

      // 2. Collect containers + tables + orphans
      const results = [];
      const usedInteractives = new Set();

      // ❌ DO NOT include td, th in containers — tables are parsed separately
      const allContainers = Array.from(document.querySelectorAll('p, li, figcaption, dt, dd, blockquote, h1, h2, h3, h4, h5, h6, article'));

      const filteredContainers = allContainers.filter(c =>
        !allContainers.some(o => o !== c && o.contains(c))
      );

      for (const container of filteredContainers) {
        if (!hasPointerEvents(container)) continue;
        const text = container.innerText?.trim();
        if (!text) continue;

        const top = container.getBoundingClientRect().top + window.scrollY;
        if (viewportHeight !== null && top > scrollY + viewportHeight) continue;

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
          headingLevel: container.tagName.match(/^H(\d)$/)?.[1] || null
        });
      }

      // Tables
      const allTables = Array.from(document.querySelectorAll('table'));
      for (const table of allTables) {
        if (!hasPointerEvents(table)) continue;
        const top = table.getBoundingClientRect().top + window.scrollY;
        if (viewportHeight !== null && (top < scrollY || top > scrollY + viewportHeight)) continue;

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
              // Final global replace:
              cell.text = text.replace(/@@REF_(\d+)@@/g, '[$1]');
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


      // Final render inside browser
      let markdown = '';



      for (const p of unique.sort((a, b) => a.y - b.y)) {
        if (p.isHeading && p.text) {
          const level = Math.min(6, p.headingLevel || 2);
          markdown += `\n${'#'.repeat(level)} ${escapeForLLM(p.text)}\n\n`;
          continue;
        }

        if (p.type === 'table') {
          markdown += renderTable(p.data);

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

            let display = `${item.text}[${ref}]`;
            if (item.tag === 'input' && (item.type === 'submit' || item.type === 'button')) {
              display = `[${item.text}][${ref}]`;
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
          // Final global replace:
          text = text.replace(/@@REF_(\d+)@@/g, '[$1]');

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
                text += ` ${item.text}[${ref}] `;
              }
            }
          }
        }

        const cleaned = text.replace(/\s+/g, ' ').trim();
        if (cleaned) markdown += cleaned + '\n\n';
      }

      return {
        view: markdown.trim(),
        elements: elementMap,
        meta: {
          scrollY,
          viewportHeight,
          fullHeight: document.documentElement.scrollHeight,
          totalRefs: refId - 1,
          url: location.href,
          title: document.title
        }
      };
    },
    { scrollY, viewportHeight }
  );

  return result;
}

// Export
module.exports = { renderMarkdown };
