/**
 * TextWeb Text Grid Renderer
 * 
 * Converts a rendered web page into a structured text grid with
 * interactive element references. No screenshots, no vision models.
 * 
 * Key design decisions:
 * - Measure actual font metrics from the page
 * - Row-grouping layout (elements grouped by Y position)
 * - Dynamic height (grows to fit all content)
 */

/**
 * Measure actual character dimensions from the page's fonts
 */

/**
 * Extract visible elements from a Playwright page with positions and metadata
 */
async function extractElements(page) {
  return await page.evaluate(() => {
    const pageScrollY = window.scrollY || document.documentElement.scrollTop;
    const pageScrollX = window.scrollX || document.documentElement.scrollLeft;
    const results = [];
    const interactiveSelector = 'a[href], button, input, select, textarea, [onclick], [role="button"], [role="link"], [tabindex]:not([tabindex="-1"]), summary';

    function isVisible(el) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return true;
    }

    function getZIndex(el) {
      let z = 0;
      let current = el;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        const zi = parseInt(style.zIndex);
        if (!isNaN(zi) && zi > z) z = zi;
        if (style.position === 'fixed' || style.position === 'sticky') z = Math.max(z, 1000);
        current = current.parentElement;
      }
      return z;
    }

    function buildSelector(el) {
      // Build a robust CSS selector for clicking
      // Priority: id > data-testid > aria > role+name > name > positional
      if (el.id) return '#' + CSS.escape(el.id);

      const tag = el.tagName.toLowerCase();

      // Stable test attributes (used by many frameworks)
      for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-test-id']) {
        const val = el.getAttribute(attr);
        if (val) return `[${attr}="${val}"]`;
      }

      // Aria-label (very stable, set by developers intentionally)
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        const sel = `${tag}[aria-label="${CSS.escape(ariaLabel)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }

      // Role + name combination
      const role = el.getAttribute('role');
      if (role) {
        const name = ariaLabel || el.textContent.trim().substring(0, 50);
        if (name) {
          const sel = `[role="${role}"]`;
          // Only use if unique enough
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }

      // Name attribute (forms)
      if (el.getAttribute('name')) return `${tag}[name="${el.getAttribute('name')}"]`;

      // href for links (use partial match for stability)
      if (tag === 'a' && el.href) {
        const href = el.getAttribute('href');
        if (href && !href.startsWith('javascript:') && href !== '#') {
          const sel = `a[href="${CSS.escape(href)}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }

      // Fallback: positional selector (least stable)
      const parent = el.parentElement;
      if (!parent) return tag;
      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(el) + 1;
      const parentSel = parent.id ? '#' + CSS.escape(parent.id) : buildSelector(parent);
      return parentSel + ' > ' + tag + ':nth-child(' + idx + ')';
    }

    function isInteractive(el) {
      return el.matches(interactiveSelector);
    }

    function domPath(el) {
      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        let idx = 1;
        let sib = current;
        while ((sib = sib.previousElementSibling)) {
          if (sib.tagName.toLowerCase() === tag) idx++;
        }
        parts.push(`${tag}:${idx}`);
        current = current.parentElement;
      }
      parts.push('body:1');
      return parts.reverse().join('/');
    }

    // Detect tables and extract their structure
    const tableData = new Map();
    document.querySelectorAll('table').forEach(table => {
      const rect = table.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const rows = [];
      table.querySelectorAll('tr').forEach(tr => {
        const cells = [];
        tr.querySelectorAll('td, th').forEach(cell => {
          const cellRect = cell.getBoundingClientRect();
          cells.push({
            x: cellRect.x,
            y: cellRect.y,
            w: cellRect.width,
            h: cellRect.height,
            text: cell.textContent.trim().slice(0, 200),
            isHeader: cell.tagName === 'TH',
            colspan: cell.colSpan || 1,
          });
        });
        if (cells.length > 0) rows.push(cells);
      });

      tableData.set(table, {
        rect,
        rows,
        colCount: Math.max(...rows.map(r => r.length), 0),
      });
    });

    // Walk the DOM tree
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          }
          const el = node;
          if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
          // Accept specific non-text elements
          if (el.matches('input, select, textarea, button, img, hr, br')) {
            return NodeFilter.FILTER_ACCEPT;
          }
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const isText = node.nodeType === Node.TEXT_NODE;
      const el = isText ? node.parentElement : node;
      if (!el) continue;

      let rect;
      if (isText) {
        const range = document.createRange();
        range.selectNodeContents(node);
        rect = range.getBoundingClientRect();
      } else {
        rect = el.getBoundingClientRect();
      }
      if (rect.width === 0 && rect.height === 0) continue;

      const tag = el.tagName.toLowerCase();
      const interactive = isInteractive(el);
      const role = el.getAttribute('role') || null;

      let text = '';
      let value = null;
      if (isText) {
        text = node.textContent.trim();
      } else if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        text = el.value || el.placeholder || '';
        value = el.value || '';
      } else if (tag === 'select') {
        const opt = el.options && el.options[el.selectedIndex];
        text = opt ? opt.text : '';
        value = el.value || '';
      } else if (tag === 'textarea') {
        text = el.value || el.placeholder || '';
        value = el.value || '';
      } else if (tag === 'img') {
        text = el.alt || '[img]';
      } else if (tag === 'hr') {
        text = '---';
      }

      // Resolve label for form elements
      let label = '';
      if (!isText && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
        // Strategy 1: <label for="id">
        if (el.id) {
          const labelEl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
          if (labelEl) label = labelEl.textContent.trim().replace(/\s*\*\s*$/, '').trim();
        }
        // Strategy 2: aria-label
        if (!label && el.getAttribute('aria-label')) {
          label = el.getAttribute('aria-label');
        }
        // Strategy 3: wrapping <label>
        if (!label) {
          const parentLabel = el.closest('label');
          if (parentLabel) label = parentLabel.textContent.trim().replace(/\s*\*\s*$/, '').trim();
        }
        // Strategy 4: name attribute as fallback
        if (!label && el.name) {
          label = el.name.replace(/[_\-\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
        }
      }

      // Determine semantic type
      let semantic = 'text';
      const headingMatch = tag.match(/^h(\d)$/);
      if (headingMatch) semantic = 'heading';
      else if (tag === 'a' && el.href) semantic = 'link';
      else if (tag === 'button' || el.getAttribute('role') === 'button') semantic = 'button';
      else if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (type === 'checkbox') semantic = 'checkbox';
        else if (type === 'radio') semantic = 'radio';
        else if (type === 'submit' || type === 'button') semantic = 'button';
        else if (type === 'file') semantic = 'file';
        else semantic = 'input';
      }
      else if (tag === 'select') semantic = 'select';
      else if (tag === 'textarea') semantic = 'textarea';
      else if (tag === 'hr') semantic = 'separator';

      // Check for list context
      if (el.closest('li') && semantic === 'text') {
        const li = el.closest('li');
        const liRect = li.getBoundingClientRect();
        if (Math.abs(rect.y - liRect.y) < 5) {
          semantic = 'listitem';
        }
      }

      // Check if inside a table cell
      const closestTd = el.closest('td, th');
      let tableCell = null;
      if (closestTd) {
        const tr = closestTd.closest('tr');
        const table = closestTd.closest('table');
        if (tr && table) {
          tableCell = {
            cellIndex: Array.from(tr.children).indexOf(closestTd),
            rowIndex: Array.from(table.querySelectorAll('tr')).indexOf(tr),
            isHeader: closestTd.tagName === 'TH',
          };
        }
      }

      const parentElement = el.parentElement;
      const parentInteractive = !!(parentElement && parentElement.matches(interactiveSelector));
      const parentPath = parentElement ? domPath(parentElement) : null;

      results.push({
        text,
        label: label || '',
        role,
        tag,
        semantic,
        headingLevel: headingMatch ? parseInt(headingMatch[1]) : 0,
        interactive,
        isTextNode: isText,
        checked: !!el.checked,
        selected: !!el.selected,
        disabled: !!el.disabled,
        required: !!el.required,
        expanded: el.getAttribute('aria-expanded') === 'true',
        placeholder: el.getAttribute('placeholder') || null,
        name: el.getAttribute('name') || '',
        alt: el.getAttribute('alt') || '',
        value,
        x: rect.x + pageScrollX,
        y: rect.y + pageScrollY,
        w: rect.width,
        h: rect.height,
        z: getZIndex(el),
        href: el.href || null,
        selector: buildSelector(el),
        domPath: domPath(el),
        parentPath,
        parentInteractive,
        tableCell,
      });
    }

    // Sort by z-index (back to front), then by document position (y, x)
    results.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
    return results;
  });
}
/**
 * TextWeb Markdown Renderer (Robust + Forms Support)
 * Captures flowing text AND standalone inputs/buttons/forms
 */

// ─── Helpers (unchanged from previous version) ───────────────────────────────
function stableHash(input) {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return (hash >>> 0).toString(36);
}

function buildSemanticModel(rawElements, layoutEntries = [], pageMeta = {}) {
  const elements = [];
  const byPath = new Map();
  const rawByPath = new Map();
  const identityCounts = new Map();

  for (let i = 0; i < rawElements.length; i++) {
    const el = rawElements[i];
    rawByPath.set(el.domPath, el);
    const name = (el.label || el.text || el.alt || el.name || '').trim();
    const baseSeed = [el.semantic || 'unknown', el.role || '', name.toLowerCase(), el.parentPath || '', el.domPath || ''].join('|');
    const ordinal = identityCounts.get(baseSeed) || 0;
    identityCounts.set(baseSeed, ordinal + 1);
    const id = `e_${stableHash(`${baseSeed}|${ordinal}`).slice(0, 8)}`;

    const semanticEl = {
      id, type: el.semantic || 'text', role: el.role || null, name: name || null,
      text: el.text || null, value: el.value ?? null, href: el.href || null,
      placeholder: el.placeholder || null, checked: typeof el.checked === 'boolean' ? el.checked : null,
      selected: typeof el.selected === 'boolean' ? el.selected : null, disabled: !!el.disabled,
      required: !!el.required, expanded: !!el.expanded, visible: true,
      parent_id: null, children: [], grid_ref: null, grid_bounds: null,
      selector: el.selector, path: el.domPath, actions: el.interactive ? ['click'] : [],
    };
    if (['input', 'textarea', 'select'].includes(semanticEl.type)) semanticEl.actions.push('type');
    if (semanticEl.type === 'select') semanticEl.actions.push('select');
    byPath.set(el.domPath, semanticEl);
    elements.push(semanticEl);
  }

  for (const el of elements) {
    const raw = rawByPath.get(el.path);
    const parentPath = raw?.parentPath;
    if (!parentPath) continue;
    const parent = byPath.get(parentPath);
    if (parent) { el.parent_id = parent.id; parent.children.push(el.id); }
  }

  return { mode: 'semantic', url: pageMeta.url || null, title: pageMeta.title || null, elements };
}

function getAction(semantic) {
  const actions = { link: 'navigate', button: 'click', input: 'type', textarea: 'type', select: 'select', checkbox: 'toggle', radio: 'select', file: 'upload' };
  return actions[semantic] || 'click';
}

function escapeForLLM(str) {
  if (!str) return '';
  return str.replace(/([*_`<>\\])/g, '\\$1').replace(/\n+/g, ' ');
}

// ─── Enhanced Extraction: Text Containers + Orphan Interactives ──────────────
async function extractParagraphs(page, scrollY, viewportHeight) {
  return await page.evaluate(({ scrollY, viewportHeight }) => {
    const results = [];
    const interactiveSelector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
    const textContainerSelector = 'p, li, td, th, figcaption, dt, dd, blockquote, h1, h2, h3, h4, h5, h6';

    // 1. Collect ALL visible interactives first
    const allInteractives = [];
    document.querySelectorAll(interactiveSelector).forEach(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return;
      if (rect.width === 0 || rect.height === 0) return;

      const top = rect.top + window.scrollY;
      if (viewportHeight !== null && (top < scrollY || top > scrollY + viewportHeight)) return;

      // Get meaningful text for the element
      let text = '';
      if (el.tagName === 'INPUT') {
        text = el.value || el.placeholder || el.name || el.id || '[input]';
      } else if (el.tagName === 'SELECT') {
        text = el.options?.[el.selectedIndex]?.text || el.name || '[select]';
      } else if (el.tagName === 'TEXTAREA') {
        text = el.value || el.placeholder || '[textarea]';
      } else {
        text = el.innerText?.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent?.trim() || '[button]';
      }
      if (!text) return;

      allInteractives.push({
        el, text,
        selector: buildSimpleSelector(el),
        href: el.tagName === 'A' ? (el.href || el.getAttribute('href')) : null,
        x: rect.left + window.scrollX, y: top, w: rect.width, h: rect.height,
        tag: el.tagName.toLowerCase(), type: el.type || null, name: el.name || null,
        placeholder: el.placeholder || null, value: el.value || null,
      });
    });

    // 2. Extract text containers with their interactives
    const usedInteractives = new Set();
    const containers = document.querySelectorAll(textContainerSelector);

    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      const style = getComputedStyle(container);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      if (rect.width === 0 || rect.height === 0) continue;

      const top = rect.top + window.scrollY;
      if (viewportHeight !== null && top > scrollY + viewportHeight) continue;

      const text = container.innerText?.trim();
      if (!text) continue;

      const containerInteractives = allInteractives.filter(item => {
        if (usedInteractives.has(item.el)) return false;
        return container.contains(item.el);
      });

      containerInteractives.forEach(item => usedInteractives.add(item.el));

      results.push({
        text, interactives: containerInteractives, y: top,
        tag: container.tagName.toLowerCase(),
        isHeading: /^H[1-6]$/.test(container.tagName),
        headingLevel: container.tagName.match(/^H(\d)$/)?.[1] || null,
      });
    }

    // 3. KEY FIX: Capture orphaned interactives (forms, standalone buttons, etc.)
    for (const item of allInteractives) {
      if (!usedInteractives.has(item.el)) {
        // Check if it's inside a form or other structural container
        const parentForm = item.el.closest('form');
        const parentContainer = parentForm || item.el.parentElement;

        results.push({
          text: item.text,
          interactives: [item],
          y: item.y,
          tag: parentContainer?.tagName.toLowerCase() || 'div',
          isHeading: false,
          headingLevel: null,
          isOrphanInteractive: true, // Flag for special rendering
        });
      }
    }

    // 4. Also capture standalone forms with their structure
    document.querySelectorAll('form').forEach(form => {
      const rect = form.getBoundingClientRect();
      const style = getComputedStyle(form);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return;
      if (rect.width === 0 || rect.height === 0) return;

      const top = rect.top + window.scrollY;
      if (viewportHeight !== null && (top < scrollY || top > scrollY + viewportHeight)) return;

      // Check if this form's inputs are already captured
      const formInputs = Array.from(form.querySelectorAll('input, button, select, textarea'));
      const hasUncaptured = formInputs.some(input => !usedInteractives.has(input));

      if (hasUncaptured) {
        const formId = form.id || form.name || `form_${results.length}`;
        results.push({
          text: `[Form: ${formId}]`,
          interactives: formInputs.map(input => {
            const inputRect = input.getBoundingClientRect();
            const inputTop = inputRect.top + window.scrollY;
            return {
              el: input,
              text: input.value || input.placeholder || input.name || input.id || `[${input.tagName.toLowerCase()}]`,
              selector: buildSimpleSelector(input),
              href: null,
              x: inputRect.left + window.scrollX, y: inputTop,
              w: inputRect.width, h: inputRect.height,
              tag: input.tagName.toLowerCase(), type: input.type || null,
              name: input.name || null, placeholder: input.placeholder || null, value: input.value || null,
            };
          }).filter(item => item.text && !usedInteractives.has(item.el)),
          y: top,
          tag: 'form',
          isHeading: false,
          headingLevel: null,
          isForm: true,
        });
      }
    });

    results.sort((a, b) => a.y - b.y);
    return results;

function buildSimpleSelector(el) {
  // Priority 1: ID (most stable)
  if (el.id) return '#' + CSS.escape(el.id);

  // Priority 2: Test attributes (framework-specific but very stable)
  for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-test-id']) {
    const val = el.getAttribute(attr);
    if (val) return `[${attr}="${CSS.escape(val)}"]`;
  }

  // Priority 3: ARIA label (explicitly set by developers)
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  const tag = el.tagName.toLowerCase();

  // Priority 4: Links with href
  if (tag === 'a' && el.href && !el.href.startsWith('javascript:')) {
    const href = el.getAttribute('href') || el.href;
    if (href && href !== '#') {
      const sel = `a[href="${CSS.escape(href)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
  }

  // Priority 5: Form elements with name attribute
  if (el.name) {
    const sel = `${tag}[name="${CSS.escape(el.name)}"]`;
    if (document.querySelectorAll(sel).length === 1) return sel;
  }

  // Priority 6: Input type + value combination (great for buttons)
  if (tag === 'input' && el.type) {
    const type = el.type.toLowerCase();
    const value = el.value?.trim();

    // For submit/reset/button inputs, value is often unique
    if (['submit', 'reset', 'button'].includes(type) && value) {
      const sel = `input[type="${type}"][value="${CSS.escape(value)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // For text/search inputs, combine type + name/placeholder
    if (['text', 'search', 'email', 'password'].includes(type)) {
      if (el.name) return `input[type="${type}"][name="${CSS.escape(el.name)}"]`;
      if (el.placeholder) {
        const sel = `input[type="${type}"][placeholder="${CSS.escape(el.placeholder)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // Fallback for inputs: at least include type
    return `input[type="${type}"]`;
  }

  // Priority 7: Buttons with unique text content
  if (tag === 'button' && el.textContent?.trim()) {
    const text = el.textContent.trim().substring(0, 50);
    const sel = `button:${CSS.escape(text)}`;
    // Note: text selector isn't standard CSS, so fallback to attribute
    if (el.getAttribute('value')) {
      const sel2 = `button[value="${CSS.escape(el.getAttribute('value'))}"]`;
      if (document.querySelectorAll(sel2).length === 1) return sel2;
    }
  }

  // Priority 8: Class name if it appears unique on the page
  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).filter(c => c && !/^[\d-]/.test(c));
    for (const cls of classes) {
      const sel = `${tag}.${CSS.escape(cls)}`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
  }

  // Priority 9: Positional fallback (least stable but better than just "input")
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
    if (siblings.length > 1) {
      const idx = siblings.indexOf(el) + 1;
      const parentSel = parent.id ? `#${CSS.escape(parent.id)}` : parent.tagName.toLowerCase();
      return `${parentSel} > ${tag}:nth-of-type(${idx})`;
    }
  }

  // Last resort: tag + type attribute if available
  if (el.type) return `${tag}[type="${el.type}"]`;

  return tag;
}
  }, { scrollY, viewportHeight });
}

// ─── Render with Support for Orphan Interactives ─────────────────────────────
function renderParagraphs(paragraphs, options = {}) {
  const { refStart = 1, includeReferences = true } = options;
  let md = '';
  let refId = refStart;
  const elementMap = {};

  for (const p of paragraphs) {
    // Headings
    if (p.isHeading) {
      const level = Math.min(6, p.headingLevel || 2);
      md += `\n${'#'.repeat(level)} ${escapeForLLM(p.text)}\n\n`;
      continue;
    }


    // Orphan interactive (standalone button/input)
    if (p.isOrphanInteractive && p.interactives.length > 0) {
      for (const item of p.interactives) {
        if (!item.text?.trim()) continue;
        const ref = refId++;
        elementMap[ref] = buildElementMapEntry(item, ref);

        let display = `[${ref}] ${item.text}`;
        if (item.tag === 'input' && (item.type === 'submit' || item.type === 'button')) {
          display = `[${ref}] [${item.text}]`;
        }
        md += `${display}\n\n`;
      }
      continue;
    }

    // Regular text paragraph with embedded references
    let text = p.text.replace(/\u00A0/g, ' ');

    if (includeReferences && p.interactives.length > 0) {
      const replacements = [];

      for (const item of p.interactives) {
        const itemText = item.text.trim();
        if (!itemText) continue;

        const ref = refId++;
        const placeholder = `@@REF_${ref}@@`;
        elementMap[ref] = buildElementMapEntry(item, ref);

        // Flexible boundary matching
        const escaped = itemText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(^|\\s|\\()(${escaped})(\\s|\\.|,|:|;|!|\\?|\\)|$)`);
        const match = text.match(regex);

        if (match) {
          text = text.replace(regex, `${match[1]}${placeholder}${match[3]}`);
          replacements.push({ placeholder, originalText: itemText, ref });
        }
      }

      for (const { placeholder, originalText, ref } of replacements) {
        text = text.split(placeholder).join(`${originalText}[${ref}]`);
      }
    }

    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      md += escapeForLLM(cleaned) + '\n\n';
    }
  }

  return { markdown: md.trim(), elementMap, totalRefs: refId - refStart };
}

function buildElementMapEntry(item, ref) {
  return {
    selector: item.selector,
    tag: item.tag,
    semantic: item.tag === 'a' ? 'link' :
             item.tag === 'button' || (item.tag === 'input' && ['submit', 'button'].includes(item.type)) ? 'button' :
             item.tag === 'input' && ['checkbox', 'radio'].includes(item.type) ? item.type :
             item.tag,
    href: item.href,
    text: item.text,
    label: item.text,
    x: item.x, y: item.y, w: item.w, h: item.h,
    action: getAction(item.tag === 'a' ? 'link' : item.tag),
    disabled: false,
    checked: item.tag === 'input' && ['checkbox', 'radio'].includes(item.type) ? !!item.checked : null,
    selected: item.tag === 'select' ? !!item.selected : null,
    required: false,
    value: item.value,
    placeholder: item.placeholder,
    name: item.name,
    type: item.type,
  };
}

// ─── Main Render Function ────────────────────────────────────────────────────
async function renderMarkdown(page, options = {}) {
  const {
    includeReferences = true,
    refStart = 1,
    scrollY = 0,
    viewportHeight = null,
  } = options;

  const vpH = viewportHeight ?? null;
  const pageMeta = {
    url: await page.url(),
    title: await page.title(),
  };

  const paragraphs = await extractParagraphs(page, scrollY, vpH);
  const { markdown, elementMap, totalRefs } = renderParagraphs(paragraphs, { refStart, includeReferences });

  const allElements = await extractElements(page).catch(() => []);
  const semanticModel = buildSemanticModel(allElements, [], pageMeta);

  return {
    view: markdown,
    elements: elementMap,
    meta: {
      cols: 80, rows: markdown.split('\n').length, scrollY, viewportHeight: vpH,
      totalRefs, charW: 1, charH: 1,
      totalElements: allElements.length, interactiveElements: totalRefs,
      url: pageMeta.url, title: pageMeta.title, renderMs: 0,
    },
    semantic: semanticModel
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = { renderMarkdown };