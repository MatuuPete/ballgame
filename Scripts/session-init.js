/* =====================================================================
 * session-init.js — one-time configuration overlay walkthrough.
 *
 * Standalone by design: it carries its own DOM helpers rather than reaching
 * into automation.js, so the same module drops into any screen or project.
 * Injected before automation.js; exposes:
 *
 *   await window.initializeSession(options)   run the sequence (once)
 *   window.resetSessionInit()                 clear the guard
 *   window.sessionInitState()                 inspect from DevTools
 *
 * Every step reports to the host via
 *   window.chrome.webview.postMessage({ type: "LOG", message: "..." })
 * ===================================================================== */
(function () {
  'use strict';

  if (window.__sessionInitInstalled) return;
  window.__sessionInitInstalled = true;

  // ==================== CONFIG ====================

  const DEFAULTS = {
    triggerLabel: 'CONFIG_PANEL',
    primaryOption: 'PRESET_OFFENSE_A',
    secondaryOption: 'PRESET_DEFENSE_B',
    confirmLabels: ['APPLY', 'CONFIRM', 'SAVE', 'OK'],

    // Optional explicit container selector. When null the modal is detected
    // heuristically — supply this if your app has a stable hook.
    modalSelector: null,

    // Restricts the trigger search to a dock/toolbar, so a stray element with
    // the same text elsewhere on the page can't be clicked by mistake.
    dockSelector: null,

    triggerTimeout: 10000,
    modalTimeout: 10000,
    optionTimeout: 6000,
    settleDelay: 350,          // pause after each click for animations
    closeAfterApply: true,
    required: false,           // true => a failure throws instead of returning
    isCancelled: null          // e.g. () => stopped, to honour the Stop button
  };

  const CLICKABLE =
    'button, [role="button"], [role="option"], [role="menuitem"], [role="tab"], ' +
    'a, li, label, input[type="button"], input[type="submit"], input[type="radio"], input[type="checkbox"]';

  const MODAL_SELECTORS = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    '.modal', '.Modal',
    '.dialog', '.Dialog',
    '.overlay', '.Overlay',
    '.popup', '.Popup',
    '[class*="modal" i]',
    '[class*="dialog" i]',
    '[class*="overlay" i]'
  ];

  // ==================== STATE ====================

  let hasInitializedSession = false;
  let inFlight = null;
  let lastResult = null;

  // ==================== HOST LOGGING ====================

  /**
   * Relays a state message to the C# host. Sends both `message` and `text`
   * because different revisions of the host read different field names —
   * cheap insurance against a silent, empty log line.
   */
  function log(message, level) {
    const line = String(message);
    try {
      if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage({
          type: 'LOG',
          level: level || 'info',
          message: line,
          text: line,
          source: 'session-init'
        });
      }
    } catch (_) { /* never let logging break the sequence */ }

    if (level === 'error') console.error('[session-init]', line);
    else if (level === 'warn') console.warn('[session-init]', line);
    else console.log('[session-init]', line);
  }

  // ==================== DOM HELPERS ====================

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute('aria-disabled') === 'true') return false;
    const cls = (el.className || '').toString().toLowerCase();
    if (/\b(disabled|inactive|locked|greyed|grayed)\b/.test(cls)) return false;
    const style = getComputedStyle(el);
    if (style.pointerEvents === 'none') return false;
    if (parseFloat(style.opacity) < 0.5) return false;
    return true;
  }

  /**
   * textContent with guaranteed whitespace between nodes. Plain textContent
   * glues adjacent spans together ("TO" + "2 LEFT" -> "TO2 LEFT"), which
   * breaks exact and word-boundary matching.
   */
  function deepText(el) {
    const parts = [];
    (function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent.trim();
        if (t) parts.push(t);
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        for (const child of node.childNodes) walk(child);
      }
    })(el);
    return parts.join(' ').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  /** Full mouse cycle — frameworks that ignore a bare .click() still respond. */
  function triggerClick(el) {
    if (!el) return false;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Scoped text search. `root` is always an explicit container so a match on
   * the base page can never be mistaken for one inside the modal.
   * Exact word match is preferred; substring is the fallback.
   */
  function findByText(root, label, { clickableOnly = true } = {}) {
    if (!root || !label) return null;
    const target = String(label).toUpperCase().replace(/\s+/g, ' ').trim();
    const selector = clickableOnly ? CLICKABLE : `${CLICKABLE}, div, span, li, p`;

    const pool = [...root.querySelectorAll(selector)]
      .filter(el => isVisible(el) && isEnabled(el));

    // 1. exact
    const exact = pool.filter(el => deepText(el) === target);
    if (exact.length) return smallest(exact);

    // 2. standalone word
    const word = pool.filter(el => deepText(el).split(' ').includes(target));
    if (word.length) return smallest(word);

    // 3. substring — last resort, still scoped to the modal
    const partial = pool.filter(el => deepText(el).includes(target));
    if (partial.length) return smallest(partial);

    // 4. widen to non-clickable text, then climb to its clickable ancestor
    if (clickableOnly) {
      const textNode = [...root.querySelectorAll('*')]
        .filter(el => isVisible(el) && deepText(el) === target);
      if (textNode.length) {
        const el = smallest(textNode);
        return el.closest(CLICKABLE) || el;
      }
    }

    return null;
  }

  /** The most specific match: wrappers contain the text too, so pick the smallest. */
  function smallest(list) {
    return list.reduce((best, el) => {
      if (!best) return el;
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    }, null);
  }

  // ==================== waitFor ====================

  /**
   * Resolves with the first truthy value returned by `condition`.
   * Driven by a MutationObserver (reacts the instant the DOM changes) plus an
   * interval (catches changes an observer cannot see, such as a class being
   * recomputed or an animation finishing).
   *
   * `stableFor` requires the condition to hold continuously for that many ms —
   * useful for modals that mount empty then populate.
   */
  function waitFor(condition, {
    timeout = 10000,
    interval = 200,
    stableFor = 0,
    label = 'condition',
    isCancelled = null
  } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let heldSince = null;
      let settled = false;

      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        observer.disconnect();
        fn(arg);
      }

      function evaluate() {
        if (settled) return;

        if (typeof isCancelled === 'function' && isCancelled()) {
          finish(reject, new Error(`Cancelled while waiting for ${label}`));
          return;
        }
        if (Date.now() - start > timeout) {
          finish(reject, new Error(`Timed out after ${timeout}ms waiting for ${label}`));
          return;
        }

        let result;
        try {
          result = condition();
        } catch (err) {
          finish(reject, err);
          return;
        }

        if (!result) { heldSince = null; return; }
        if (stableFor > 0) {
          if (heldSince === null) { heldSince = Date.now(); return; }
          if (Date.now() - heldSince < stableFor) return;
        }
        finish(resolve, result);
      }

      const timer = setInterval(evaluate, interval);
      const observer = new MutationObserver(evaluate);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'aria-disabled', 'aria-selected']
      });

      evaluate();
    });
  }

  // ==================== MODAL DETECTION ====================

  /**
   * Finds the overlay container. Preference order:
   *   1. an explicit selector supplied by the caller
   *   2. a dialog-ish element that actually contains the expected option text
   *   3. any dialog-ish element
   *   4. the largest fixed/absolute high-z-index container
   * Returns null rather than falling back to `document`, because an unscoped
   * search is exactly the failure this module exists to avoid.
   */
  function findModal(opts) {
    if (opts.modalSelector) {
      const explicit = document.querySelector(opts.modalSelector);
      return explicit && isVisible(explicit) ? explicit : null;
    }

    const dialogs = [];
    for (const sel of MODAL_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el) && !dialogs.includes(el)) dialogs.push(el);
      }
    }

    // Prefer a dialog that already holds one of the options we came for.
    const wanted = [opts.primaryOption, opts.secondaryOption]
      .filter(Boolean)
      .map(s => s.toUpperCase());

    if (wanted.length) {
      const withOption = dialogs.filter(d => {
        const text = deepText(d);
        return wanted.some(w => text.includes(w));
      });
      if (withOption.length) return innermost(withOption);
    }

    if (dialogs.length) return innermost(dialogs);

    // Last resort: a floating layer sitting above the page.
    const floating = [...document.querySelectorAll('body *')].filter(el => {
      if (!isVisible(el)) return false;
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') return false;
      const z = parseInt(s.zIndex, 10);
      if (!Number.isFinite(z) || z < 10) return false;
      const r = el.getBoundingClientRect();
      return r.width > window.innerWidth * 0.2 && r.height > window.innerHeight * 0.2;
    });
    if (!floating.length) return null;

    return floating.reduce((best, el) => {
      const za = parseInt(getComputedStyle(el).zIndex, 10) || 0;
      const zb = parseInt(getComputedStyle(best).zIndex, 10) || 0;
      return za > zb ? el : best;
    });
  }

  /** When dialogs nest, the innermost one is the real content container. */
  function innermost(list) {
    const leaves = list.filter(el => !list.some(other => other !== el && el.contains(other)));
    return (leaves.length ? leaves : list)[0];
  }

  function findCloseControl(root) {
    const aria = [...root.querySelectorAll('[aria-label]')].find(el =>
      /close|dismiss/i.test(el.getAttribute('aria-label') || '') && isVisible(el) && isEnabled(el));
    if (aria) return aria;

    const glyphs = new Set(['×', '✕', '✖', 'X', '⨯']);
    const glyph = [...root.querySelectorAll('*')].find(el =>
      isVisible(el) && glyphs.has(deepText(el)));
    if (glyph) return glyph.closest(CLICKABLE) || glyph;

    return [...root.querySelectorAll('[class*="close" i]')]
      .find(el => isVisible(el) && isEnabled(el)) || null;
  }

  /** Best-effort read of whether an option ended up selected. */
  function looksSelected(el) {
    if (!el) return false;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    if (el.checked === true) return true;
    const cls = (el.className || '').toString().toLowerCase();
    return /\b(selected|active|checked|chosen|is-on)\b/.test(cls);
  }

  // ==================== THE SEQUENCE ====================

  async function runSequence(opts) {
    const steps = [];
    const cancelled = () => typeof opts.isCancelled === 'function' && opts.isCancelled();

    // ---- Step 1: open the panel -------------------------------------
    log(`Locating trigger "${opts.triggerLabel}"...`);

    const dock = opts.dockSelector ? document.querySelector(opts.dockSelector) : document.body;
    if (opts.dockSelector && !dock) {
      throw new Error(`Dock container "${opts.dockSelector}" not found`);
    }

    const trigger = await waitFor(
      () => findByText(dock, opts.triggerLabel),
      {
        timeout: opts.triggerTimeout,
        label: `trigger "${opts.triggerLabel}"`,
        isCancelled: opts.isCancelled
      }
    );

    triggerClick(trigger);
    steps.push('trigger');
    log(`Trigger "${opts.triggerLabel}" clicked.`);
    await sleep(opts.settleDelay);
    if (cancelled()) throw new Error('Cancelled after trigger');

    // ---- Step 2: wait for the overlay -------------------------------
    log('Waiting for configuration overlay...');

    const modal = await waitFor(
      () => findModal(opts),
      {
        timeout: opts.modalTimeout,
        stableFor: 250,          // let it finish mounting before we query it
        label: 'configuration overlay',
        isCancelled: opts.isCancelled
      }
    );

    steps.push('modal');
    log(`Overlay detected (<${modal.tagName.toLowerCase()}>` +
        `${modal.id ? '#' + modal.id : ''}). Queries are now scoped to it.`);

    // ---- Step 3: select the presets ---------------------------------
    // Every lookup below passes `modal` as the root, never `document`.
    const primary = await selectOption(modal, opts.primaryOption, 'primary', opts);
    if (primary) steps.push('primary');
    if (cancelled()) throw new Error('Cancelled after primary selection');

    const secondary = await selectOption(modal, opts.secondaryOption, 'secondary', opts);
    if (secondary) steps.push('secondary');
    if (cancelled()) throw new Error('Cancelled after secondary selection');

    // ---- Step 4: confirm, then close --------------------------------
    let confirmed = false;
    for (const label of opts.confirmLabels) {
      const btn = findByText(modal, label);
      if (btn) {
        triggerClick(btn);
        confirmed = true;
        steps.push('confirm:' + label);
        log(`Confirmation "${label}" clicked.`);
        await sleep(opts.settleDelay);
        break;
      }
    }
    if (!confirmed) {
      log(`No confirmation control found (looked for ${opts.confirmLabels.join(', ')}).`, 'warn');
    }

    if (opts.closeAfterApply) {
      await closeOverlay(modal, opts);
      steps.push('closed');
    }

    return { ok: true, steps, confirmed };
  }

  /** Clicks one option inside the modal and reports whether it took. */
  async function selectOption(modal, label, role, opts) {
    if (!label) return false;

    log(`Selecting ${role} option "${label}"...`);

    let option;
    try {
      option = await waitFor(
        () => findByText(modal, label),
        {
          timeout: opts.optionTimeout,
          label: `${role} option "${label}"`,
          isCancelled: opts.isCancelled
        }
      );
    } catch (err) {
      log(`${role} option "${label}" not found: ${err.message}`, 'warn');
      return false;
    }

    triggerClick(option);
    await sleep(opts.settleDelay);

    // Not all UIs expose selection state; absence of a marker is not failure.
    if (looksSelected(option)) log(`${role} option "${label}" is selected.`);
    else log(`${role} option "${label}" clicked (no selection marker exposed).`);

    return true;
  }

  async function closeOverlay(modal, opts) {
    const closeBtn = findCloseControl(modal);
    if (closeBtn) {
      triggerClick(closeBtn);
      log('Overlay closed via close control.');
    } else {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true
      }));
      log('No close control found — sent Escape.', 'warn');
    }

    // Confirm it actually went away rather than assuming.
    try {
      await waitFor(() => (!modal.isConnected || !isVisible(modal)) || null,
        { timeout: 3000, label: 'overlay to dismiss', isCancelled: opts.isCancelled });
      log('Overlay dismissed.');
    } catch {
      log('Overlay still visible after close attempt.', 'warn');
    }
  }

  // ==================== PUBLIC ENTRY POINT ====================

  /**
   * Runs the setup once per session cycle.
   *
   *   await initializeSession();                       // all defaults
   *   await initializeSession({ triggerLabel: 'SETUP',
   *                             primaryOption: 'PRESET_OFFENSE_C' });
   *   await initializeSession({ force: true });        // ignore the guard
   *
   * Resolves to { ok, skipped?, steps, error? }. Never throws unless
   * `required: true` was passed, so a cosmetic setup step cannot take the
   * whole run down with it.
   */
  window.initializeSession = function (options) {
    const opts = Object.assign({}, DEFAULTS, options || {});

    // Single-execution guard.
    if (hasInitializedSession && !opts.force) {
      log('Session already initialised — skipping.');
      return Promise.resolve({ ok: true, skipped: true, steps: [] });
    }

    // Concurrency guard: two callers get the same promise, not two runs.
    if (inFlight) {
      log('Initialisation already in progress — awaiting the existing run.');
      return inFlight;
    }

    inFlight = (async () => {
      const started = Date.now();
      log(`Starting session initialisation — trigger "${opts.triggerLabel}", ` +
          `presets "${opts.primaryOption}" + "${opts.secondaryOption}".`);

      try {
        const result = await runSequence(opts);
        hasInitializedSession = true;
        lastResult = result;
        log(`Initialisation complete in ${Date.now() - started}ms ` +
            `(steps: ${result.steps.join(' → ')}).`, 'success');
        return result;
      } catch (err) {
        const message = (err && err.message) || String(err);
        lastResult = { ok: false, error: message, steps: [] };
        log(`Initialisation failed: ${message}`, 'error');

        // The guard is deliberately NOT set on failure, so a later attempt
        // can retry rather than the session being stuck half-configured.
        if (opts.required) throw err;
        return lastResult;
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  };

  /** Clears the guard — call on logout, navigation, or a new session cycle. */
  window.resetSessionInit = function () {
    hasInitializedSession = false;
    inFlight = null;
    lastResult = null;
    log('Session init guard reset.');
    return 'reset';
  };

  window.sessionInitState = function () {
    return { hasInitializedSession, running: inFlight !== null, lastResult };
  };

  // Exposed for manual probing from DevTools.
  window.__sessionInit = {
    findModal: () => findModal(DEFAULTS),
    findByText,
    waitFor,
    deepText,
    triggerClick,
    DEFAULTS
  };

  log('Module loaded — call initializeSession() to run.');
})();
