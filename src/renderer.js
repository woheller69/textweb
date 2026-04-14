/**
TextWeb Text Markdown Renderer
Converts a rendered web page into a structured Markdown document with
interactive element references.
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
    // 1. Define buildSimpleSelector FIRST so it's available in scope
    function buildSimpleSelector(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-test-id']) {
        const val = el.getAttribute(attr);
        if (val) return `[${attr}="${CSS.escape(val)}"]`;
      }
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        const sel = `${el.tagName.toLowerCase()}[aria-label="${CSS.escape(ariaLabel)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && el.href && !el.href.startsWith('javascript:')) {
        const href = el.getAttribute('href') || el.href;
        if (href && href !== '#') {
          const sel = `a[href="${CSS.escape(href)}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
      if (el.name) {
        const sel = `${tag}[name="${CSS.escape(el.name)}"]`;
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
      if (tag === 'input' && el.type) {
        const type = el.type.toLowerCase();
        const value = el.value?.trim();
        if (['submit', 'reset', 'button'].includes(type) && value) {
          const sel = `input[type="${type}"][value="${CSS.escape(value)}"]`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
        if (['text', 'search', 'email', 'password'].includes(type)) {
          if (el.name) return `input[type="${type}"][name="${CSS.escape(el.name)}"]`;
          if (el.placeholder) {
            const sel = `input[type="${type}"][placeholder="${CSS.escape(el.placeholder)}"]`;
            if (document.querySelectorAll(sel).length === 1) return sel;
          }
        }
        return `input[type="${type}"]`;
      }
      if (tag === 'button' && el.textContent?.trim()) {
        const text = el.textContent.trim().substring(0, 50);
        if (el.getAttribute('value')) {
          const sel2 = `button[value="${CSS.escape(el.getAttribute('value'))}"]`;
          if (document.querySelectorAll(sel2).length === 1) return sel2;
        }
      }
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).filter(c => c && !/^[\d-]/.test(c));
        for (const cls of classes) {
          const sel = `${tag}.${CSS.escape(cls)}`;
          if (document.querySelectorAll(sel).length === 1) return sel;
        }
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(el) + 1;
          const parentSel = parent.id ? `#${CSS.escape(parent.id)}` : parent.tagName.toLowerCase();
          return `${parentSel} > ${tag}:nth-of-type(${idx})`;
        }
      }
      if (el.type) return `${tag}[type="${el.type}"]`;
      return tag;
    }

    const results = [];
    const interactiveSelector = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
    const textContainerSelector = 'p, li, td, th, figcaption, dt, dd, blockquote, h1, h2, h3, h4, h5, h6, article';

    // 2. Collect ALL visible interactives first
    const allInteractives = [];
    document.querySelectorAll(interactiveSelector).forEach(el => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return;
      if (rect.width === 0 || rect.height === 0) return;

      const top = rect.top + window.scrollY;
      if (viewportHeight !== null && (top < scrollY || top > scrollY + viewportHeight)) return;

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

    // 3. Extract text containers with their interactives
    const usedInteractives = new Set();
    const allContainers = Array.from(document.querySelectorAll(textContainerSelector));

    // Filter: keep containers NOT nested inside another matched text container
    const filteredContainers = allContainers.filter(container => {
      return !allContainers.some(other =>
        other !== container &&
        other.contains(container)
      );
    });

    for (const container of filteredContainers) {
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
        text,
        interactives: containerInteractives,
        y: top,
        tag: container.tagName.toLowerCase(),
        isHeading: /^H[1-6]$/.test(container.tagName),
        headingLevel: container.tagName.match(/^H(\d)$/)?.[1] || null,
      });
    }

    // 4. Capture orphaned interactives
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

    // 5. Smart deduplication: remove identical text+link within 50px vertical range
    const unique = [];
    for (const item of results) {
      const isDuplicate = unique.some(u => {
        const sameText = u.text === item.text;
        const closeVertically = Math.abs(u.y - item.y) < 50;
        const sameLink = u.interactives[0]?.href === item.interactives[0]?.href;
        return sameText && closeVertically && sameLink;
      });
      if (!isDuplicate) unique.push(item);
    }

    return unique.sort((a, b) => a.y - b.y);
  }, { scrollY, viewportHeight });
}

// ─── Render with Support for Orphan Interactives ─────────────────────────────
function renderParagraphs(paragraphs, options = {}) {
  const { refStart = 1 } = options;
  let md = '';
  let refId = refStart;
  const elementMap = {};

  for (const p of paragraphs) {
    if (p.isHeading) {
      const level = Math.min(6, p.headingLevel || 2);
      md += `\n${'#'.repeat(level)} ${escapeForLLM(p.text)}\n\n`;
      continue;
    }

    if (p.isOrphanInteractive && p.interactives.length > 0) {
      for (const item of p.interactives) {
        if (item.tag === 'div' || item.tag === 'span' || item.tag === 'section') continue;
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

    if (p.interactives.length > 0) {
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

function truncateText(text, maxLen = 80) {
  if (!text) return text;

  const newlineIndex = text.indexOf('\n');
  const limit = (newlineIndex !== -1 && newlineIndex < maxLen) ? newlineIndex : maxLen;

  if (text.length <= limit) return text;

  return text.substring(0, limit).trim() + '…';
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
    text: truncateText(item.text),
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
    scrollY = 0,
    viewportHeight = null,
  } = options;

  const pageMeta = {
    url: await page.url(),
    title: await page.title(),
    fullHeight: await page.evaluate("document.documentElement.scrollHeight"),
  };

  const paragraphs = await extractParagraphs(page, scrollY, viewportHeight);
  const { markdown, elementMap, totalRefs } = renderParagraphs(paragraphs);

  return {
    view: markdown,
    elements: elementMap,
    meta: {
      scrollY: scrollY,
      viewportHeight: viewportHeight,
      fullHeight: pageMeta.fullHeight,
      totalRefs: totalRefs,
      url: pageMeta.url,
      title: pageMeta.title,
    }
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────
module.exports = { renderMarkdown };