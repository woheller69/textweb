/**
 * AgentBrowser — the main interface for AI agents to browse the web
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// Register the stealth plugin globally
chromium.use(StealthPlugin());

const DEFAULT_VIEWPORT = { width: 800, height: 1800 };
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const { renderMarkdown } = require('./renderer');

/**
 * AgentBrowser — manages a headless/headed Chromium instance for web automation and perception.
 * Provides high-level actions (navigate, click, type, scroll, etc.) with retry logic,
 * viewport-aware rendering, and element introspection via reference IDs.
 */
class AgentBrowser {
  /**
   * Construct an AgentBrowser instance.
   * @param {Object} [options] - Configuration options
   * @param {number} [options.timeout=10000] - Default operation timeout in ms
   * @param {number} [options.retries=2] - Default number of retries per operation
   * @param {number} [options.retryDelayMs=250] - Delay between retries in ms
   */
  constructor(options = {}) {
    /**
     * Current vertical scroll position (in pixels from top)
     * @type {number}
     */
    this.scrollY = 0;
    /**
     * Playwright Browser instance (when launched)
     * @type {import('playwright').Browser|null}
     */
    this.browser = null;
    /**
     * Playwright BrowserContext instance
     * @type {import('playwright').BrowserContext|null}
     */
    this.context = null;
    /**
     * Playwright Page instance for current session
     * @type {import('playwright').Page|null}
     */
    this.page = null;
    /**
     * Last rendered result (`view`, `elements`, `meta`)
     * @type {Object|null}
     */
    this.lastResult = null;
    /**
     * Whether to launch browser in headful mode (for debugging)
     * @type {boolean}
     */
    this.headless = false; //open browser window for debugging. Sometimes we need to accept cookies, etc
    /**
     * Default timeout for operations (ms)
     * @type {number}
     */
    this.defaultTimeout = options.timeout || 10000;
    /**
     * Default number of retries per operation
     * @type {number}
     */
    this.defaultRetries = options.retries ?? 2;
    /**
     * Default delay between retries (ms)
     * @type {number}
     */
    this.defaultRetryDelayMs = options.retryDelayMs ?? 250;
  }

  /**
   * Execute an async operation with automatic retries and exponential backoff.
   * @param {string} actionName - Human-readable name for error messages
   * @param {function():Promise<T>} fn - Async function to retry
   * @param {Object} [options] - Optional override for retry settings
   * @param {number} [options.retries] - Overrides default retries
   * @param {number} [options.retryDelayMs] - Overrides default delay
   * @returns {Promise<T>} Result of fn on success
   * @throws {Error} If all attempts fail
   * @template T
   */
  async _withRetries(actionName, fn, options = {}) {
    const retries = options.retries ?? this.defaultRetries;
    const retryDelayMs = options.retryDelayMs ?? this.defaultRetryDelayMs;

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (attempt >= retries) break;
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }

    throw new Error(`${actionName} failed after ${retries + 1} attempt(s): ${lastError?.message || 'unknown error'}`);
  }

  /**
   * Generate context launch options (viewport, user agent, storage state).
   * @param {string|null} storageStatePath - Optional path to preloaded storage state
   * @returns {Object} Options compatible with `browser.newContext()`
   */
  _contextOptions(storageStatePath = null) {
    const opts = {
      viewport: DEFAULT_VIEWPORT,
      userAgent: DEFAULT_USER_AGENT,
    };
    if (storageStatePath) {
      opts.storageState = storageStatePath;
    }
    return opts;
  }

  /**
   * Create a new browser context and page, applying network route filters.
   * Images and media resources are blocked to save bandwidth.
   * @param {string|null} storageStatePath - Optional path to load storage state from
   * @returns {Promise<void>}
   */
  async _createContext(storageStatePath = null) {
    this.context = await this.browser.newContext(this._contextOptions(storageStatePath));
    this.page = await this.context.newPage();
    await this.page.route("**/*", (route, request) => {
      if (request.resourceType() === "image") {  //we do not need to download images
          route.abort();
      } else if (request.resourceType === "media") { //we do not need audio and video
        //abort the route
          route.abort();
      } else {
          route.continue();
      }
    });
    this.page.setDefaultTimeout(this.defaultTimeout);
  }

  /**
   * Launch browser (if needed) and create a new context (if needed).
   * Idempotent: safe to call multiple times.
   * @param {Object} [options] - Launch options
   * @param {string} [options.storageStatePath] - Path to load cookies/localStorage from
   * @returns {AgentBrowser} this instance (for chaining)
   */
  async launch(options = {}) {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: this.headless,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    }

    if (!this.context) {
      await this._createContext(options.storageStatePath || null);
    }

    return this;
  }

  /**
   * Navigate to a URL and perform initial render.
   * Waits for `load` (page is fully loaded) + short network settle
   * @param {string} url - Target URL to navigate to
   * @param {Object} [options] - Navigation options (passed to `_withRetries`)
   * @param {number} [options.timeoutMs] - Override timeout
   * @returns {Promise<Object>} Render result: `{ view, elements, meta }`
   */
  async navigate(url, options = {}) {
    if (!this.page) await this.launch();
    this.scrollY = 0;

    await this._withRetries('navigate', async () => {
      // Wait until page is fully loaded
      await this.page.goto(url, { waitUntil: 'load', timeout: options.timeoutMs || this.defaultTimeout });
      // Wait for network to settle or 3s max — whichever comes first
      await Promise.race([
        this.page.waitForLoadState('networkidle').catch(() => {}),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    }, options);

    return await this.snapshot();
  }

  /**
   * Capture and render the current viewport state.
   * Updates `scrollY`, then invokes `renderMarkdown`.
   * @returns {Promise<Object>} Render result: `{ view, elements, meta }`
   */
  async snapshot() {
    if (!this.page) throw new Error('No page open. Call navigate() first.');
    //TODO: make an option for this
    // ✅ Remove ALL images and videos after page settles
    await this.page.evaluate(() => {
      document.querySelectorAll(
        'img, video, picture, source, canvas, .aj-video-player, .video-page, .video-js, .live-stream-widget, .responsive-image'
      ).forEach(el => el.remove());
    });
    this.scrollY = await this.page.evaluate(() => window.scrollY);  //sync with browser window

    this.lastResult = await renderMarkdown(this.page, {
      scrollY: this.scrollY,
      viewportHeight: DEFAULT_VIEWPORT.height,
    });

    //console.log('\n📊 Meta Summary:\n');
    //console.log(`  URL: ${this.lastResult.meta.url}`);
    //console.log(`  Title: ${this.lastResult.meta.title}`);
    //console.log(`  Scroll Y: ${this.lastResult.meta.scrollY}px`);
    //console.log(`  Viewport Height: ${this.lastResult.meta.viewportHeight}px`);
    //console.log(`  Full Height: ${this.lastResult.meta.fullHeight}px`);
    //console.log(`  Total References: ${this.lastResult.meta.totalRefs}`);

    return this.lastResult;
  }

  /**
   * Check whether a given href is a valid, navigable HTTP/HTTPS URL.
   * @param {string|null} href - URL string to validate
   * @returns {boolean}
   */
  _isNavigableUrl(href) {
    if (!href || typeof href !== 'string') return false;
    try {
      const url = new URL(href);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Click an element by reference ID, either via navigation (if link) or simulated click.
   * - For links: uses `navigate()` for speed and robustness
   * - For buttons/interactive elements: uses Playwright locator + scroll + offset click
   * @param {string|number} ref - Reference ID or selector key
   * @param {Object} [options] - Click options (passed to `_withRetries`)
   * @returns {Promise<Object>} Updated render result after action
   */
  async click(ref, options = {}) {
    const el = this._getElement(ref); // Already validates existence

    // 🎯 1. If it's a valid absolute URL, navigate directly (bypasses viewport issues)
    if (this._isNavigableUrl(el.href)) {
      console.debug(`🔗 Navigating for ref=${ref}: ${el.href}`);
      return await this.navigate(el.href, options);
    }

    // 🖱️ 2. Fallback to click
    console.debug(`🖱️ Clicking for ref=${ref} (selector: ${el.selector}) Name: ${el.name} Tag: ${el.tag} Semantic: ${el.semantic} Text: ${el.text}`);

    if (!el.selector) {
      throw new Error(`Element ref=${ref} has no 'selector' property`);
    }

    await this._withRetries(`click ref=${ref}`, async () => {
      // 🔒 Guarantee page exists before locator creation
      if (!this.page) await this.launch();

      const locator = this.page.getByRole(el.semantic, { name: el.text }).first();

      // ✅ Await each step separately. NO CHAINING.
      await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
      await this.page.waitForTimeout(150); // Let layout/animations settle
      await locator.click({
        force: true,
        position: { x: 10, y: 10 }, // Offset avoids sticky header/overlay blocks
        timeout: 5000
      });

      await this._settle();
    }, options);

    return await this.snapshot();
  }

  /**
   * Type into an element (input/textarea) by reference ID.
   * Clicks first, then fills.
   * @param {string|number} ref - Reference ID
   * @param {string} text - Text to type
   * @param {Object} [options] - Options (passed to `_withRetries`)
   * @returns {Promise<Object>} Updated render result
   */
  async type(ref, text, options = {}) {
    const el = this._getElement(ref);
    await this._withRetries(`type ref=${ref}`, async () => {
      await this.page.click(el.selector);
      await this.page.fill(el.selector, text);
    }, options);
    return await this.snapshot();
  }

  /**
   * Fill a field by CSS selector without re-rendering (faster for batch fills).
   * Uses native `fill` first, falls back to character-by-character `type` if needed.
   * @param {string} selector - CSS selector
   * @param {string} text - Text to fill
   * @returns {Promise<void>}
   */
  async fillBySelector(selector, text) {
    try {
      await this.page.click(selector, { timeout: 5000 });
      await this.page.fill(selector, text);
    } catch (e) {
      // Fallback: try typing character by character (for contenteditable, etc.)
      try {
        await this.page.click(selector, { timeout: 5000 });
        await this.page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (el) { el.value = ''; el.textContent = ''; }
        }, selector);
        await this.page.type(selector, text, { delay: 10 });
      } catch (e2) {
        throw new Error(`Cannot fill ${selector}: ${e.message}`);
      }
    }
  }

  /**
   * Upload one or more files via file input.
   * @param {string} selector - CSS selector for `<input type="file">`
   * @param {string|string[]} filePaths - File path(s) to upload
   * @returns {Promise<void>}
   */
  async uploadBySelector(selector, filePaths) {
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    await this.page.setInputFiles(selector, paths);
  }

  /**
   * Press a keyboard key (e.g., 'Enter', 'Escape').
   * Automatically settles after action.
   * @param {string} key - Key name (e.g., 'Enter', 'Tab', 'ArrowDown')
   * @param {Object} [options] - Options (passed to `_withRetries`)
   * @returns {Promise<Object>} Updated render result
   */
  async press(key, options = {}) {
    await this._withRetries(`press key=${key}`, async () => {
      await this.page.keyboard.press(key);
      await this._settle();
    }, options);
    return await this.snapshot();
  }

  /**
   * Upload file(s) to an element by reference ID.
   * @param {string|number} ref - Reference ID
   * @param {string|string[]} filePaths - File path(s)
   * @param {Object} [options] - Options (passed to `_withRetries`)
   * @returns {Promise<Object>} Updated render result
   */
  async upload(ref, filePaths, options = {}) {
    const el = this._getElement(ref);
    const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
    await this._withRetries(`upload ref=${ref}`, async () => {
      await this.page.setInputFiles(el.selector, paths);
    }, options);
    return await this.snapshot();
  }

  /**
   * Select an option in a `<select>` element by reference ID.
   * @param {string|number} ref - Reference ID
   * @param {string} value - Option value to select
   * @param {Object} [options] - Options (passed to `_withRetries`)
   * @returns {Promise<Object>} Updated render result
   */
  async select(ref, value, options = {}) {
    const el = this._getElement(ref);
    await this._withRetries(`select ref=${ref}`, async () => {
      await this.page.selectOption(el.selector, value);
    }, options);
    return await this.snapshot();
  }

  /**
   * Scroll the viewport vertically.
   * @param {'up'|'down'|'top'} direction - Scroll direction
   * @param {number} [amount=1] - Number of viewport heights to scroll
   * @returns {Promise<Object>} Updated render result
   */
  async scroll(direction = 'down', amount = 1) {
    // Scroll by one "page" = viewport height

    const delta = DEFAULT_VIEWPORT.height * amount;
    if (direction === 'down') {
      this.scrollY += delta;
    } else if (direction === 'up') {
      this.scrollY = Math.max(0, this.scrollY - delta);
    } else if (direction === 'top') {
      this.scrollY = 0;
    }
    await this.page.evaluate((y) => window.scrollTo(0, y), this.scrollY);
    await this.page.waitForTimeout(500);
    return await this.snapshot();
  }

  /**
   * Execute arbitrary JavaScript in page context.
   * @param {function(...args):T} fn - Function to evaluate
   * @param {any} arg - Argument passed to `fn`
   * @returns {Promise<T>} Result of evaluation
   * @template T
   */
  async evaluate(fn, arg) {
    return await this.page.evaluate(fn, arg);
  }

  /**
   * Save cookies/localStorage/sessionStorage to disk (Playwright storage state).
   * @param {string} path - Output path (e.g., `./state.json`)
   * @returns {Promise<{saved: true, path: string}>}
   * @throws {Error} If no context is open
   */
  async saveStorageState(path) {
    if (!this.context) throw new Error('No browser context open.');
    await this.context.storageState({ path });
    return { saved: true, path };
  }

  /**
   * Load cookies/localStorage/sessionStorage from disk into a fresh context.
   * Closes any existing context/page.
   * @param {string} path - Input path (e.g., `./state.json`)
   * @returns {Promise<{loaded: true, path: string}>}
   */
  async loadStorageState(path) {
    if (!this.browser) {
      await this.launch();
    }

    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }

    await this._createContext(path);
    this.scrollY = 0;
    this.lastResult = null;
    return { loaded: true, path };
  }

  /**
   * Wait until specified conditions are met (selector, text, or URL match), then snapshot.
   * @param {Object} options - Conditions to wait for
   * @param {string} [options.selector] - Wait for element matching selector
   * @param {'visible'|'hidden'|'attached'|'detached'} [options.state='visible'] - Element state
   * @param {string} [options.text] - Wait for text in body
   * @param {string} [options.urlIncludes] - Wait for URL substring
   * @param {number} [options.timeoutMs] - Global timeout
   * @param {number} [options.pollMs=100] - Polling interval
   * @returns {Promise<Object>} Updated render result
   */
  async waitFor(options = {}) {
    if (!this.page) throw new Error('No page open. Call navigate() first.');

    const timeout = options.timeoutMs || this.defaultTimeout;
    const pollMs = options.pollMs || 100;

    await this._withRetries('waitFor', async () => {
      const waits = [];

      if (options.selector) {
        waits.push(
          this.page.waitForSelector(options.selector, {
            state: options.state || 'visible',
            timeout,
          })
        );
      }

      if (options.text) {
        waits.push(
          this.page.waitForFunction(
            (text) => document.body && document.body.innerText.includes(text),
            options.text,
            { timeout, polling: pollMs }
          )
        );
      }

      if (options.urlIncludes) {
        waits.push(
          this.page.waitForFunction(
            (needle) => window.location.href.includes(needle),
            options.urlIncludes,
            { timeout, polling: pollMs }
          )
        );
      }

      if (!waits.length) {
        await this.page.waitForTimeout(timeout);
      } else {
        await Promise.all(waits);
      }
    }, options);

    await this._settle();
    return await this.snapshot();
  }

  /**
   * Assert a field's current value/text using various comparators.
   * @param {string|number} ref - Reference ID
   * @param {string|number} expected - Expected value
   * @param {Object} [options] - Assertion options
   * @param {'equals'|'includes'|'regex'|'not_empty'} [options.comparator='equals'] - Comparison strategy
   * @param {string|null} [options.attribute=null] - Optional attribute to compare (instead of text/value)
   * @returns {Promise<{pass: boolean, ref: number|string, selector: string, comparator: string, expected: string, actual: string}>}
   */
  async assertField(ref, expected, options = {}) {
    if (!this.page) throw new Error('No page open. Call navigate() first.');
    const el = this._getElement(ref);
    const comparator = options.comparator || 'equals';
    const attribute = options.attribute || null;

    const actual = await this.page.evaluate(({ selector, attributeName }) => {
      const target = document.querySelector(selector);
      if (!target) return null;

      if (attributeName) {
        return target.getAttribute(attributeName);
      }

      const tag = (target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        return target.value ?? '';
      }
      return (target.textContent || '').trim();
    }, { selector: el.selector, attributeName: attribute });

    let pass = false;
    const actualStr = actual == null ? '' : String(actual);
    const expectedStr = expected == null ? '' : String(expected);

    switch (comparator) {
      case 'equals':
        pass = actualStr === expectedStr;
        break;
      case 'includes':
        pass = actualStr.includes(expectedStr);
        break;
      case 'regex': {
        const re = new RegExp(expectedStr);
        pass = re.test(actualStr);
        break;
      }
      case 'not_empty':
        pass = actualStr.trim().length > 0;
        break;
      default:
        throw new Error(`Unknown comparator: ${comparator}`);
    }

    return {
      pass,
      ref,
      selector: el.selector,
      comparator,
      expected: expectedStr,
      actual: actualStr,
    };
  }

  /**
   * Close the browser, cleanup contexts and pages.
   * Safe to call multiple times.
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  /**
   * Get the current page URL.
   * @returns {string|null} Current URL or `null` if no page active
   */
  getCurrentUrl() {
    return this.page ? this.page.url() : null;
  }

  /**
   * Query elements matching a CSS selector and return metadata.
   * @param {string} selector - CSS selector
   * @returns {Promise<Array<{tag: string, text: string, selector: string, visible: boolean, href: string|null, value: string|null}>>}
   */
  async query(selector) {
    if (!this.page) throw new Error('No page open. Call navigate() first.');
    return await this.page.evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      return Array.from(els).map((el, i) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().substring(0, 200),
        selector: `${sel}:nth-child(${i + 1})`,
        visible: el.offsetParent !== null,
        href: el.href || null,
        value: el.value || null,
      }));
    }, selector);
  }

  /**
   * Take a screenshot (for debugging).
   * @param {Object} [options] - Optional screenshot options (see Playwright docs)
   * @returns {Promise<Buffer>} PNG buffer (or path if `path` is provided)
   */
  async screenshot(options = {}) {
    if (!this.page) throw new Error('No page open. Call navigate() first.');
    return await this.page.screenshot({
      fullPage: false,
      type: 'png',
      ...options,
    });
  }

  /**
   * Navigate back in browser history and snapshot.
   * @returns {Promise<Object>} Updated render result
   */
  async goBack() {
    await this.page.goBack();
    return await this.snapshot();
  }

  /**
   * Wait for page to settle after interaction: tries `networkidle` first, falls back to 3s timeout.
   * Used internally to ensure DOM is stable before snapshot/click/etc.
   * @returns {Promise<void>}
   */
  async _settle() {
    await Promise.race([
      this.page.waitForLoadState('networkidle').catch(() => {}),
      new Promise(r => setTimeout(r, 3000)),
    ]);
  }

  /**
   * Get interactive element metadata by reference ID.
   * Validates existence and returns raw entry from `lastResult.elements`.
   * @param {string|number} ref - Reference ID
   * @returns {InteractiveElement} Element metadata
   * @throws {Error} If no snapshot exists or element not found
   */
  _getElement(ref) {
    if (!this.lastResult) throw new Error('No snapshot. Navigate first.');
    const el = this.lastResult.elements[ref];
    if (!el) throw new Error(`Element ref [${ref}] not found. Available: ${Object.keys(this.lastResult.elements).join(', ')}`);
    return el;
  }

}

module.exports = { AgentBrowser };
