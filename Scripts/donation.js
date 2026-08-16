/* =====================================================================
 * donation.js — Alliance donation helper.
 *
 * Flow: click ALLIANCE in the bottom dock -> the Alliance overlay opens ->
 * type an amount -> click DONATE -> click the overlay's close (X) button.
 *
 * CONFIRMED from screenshots: the dock has an ALLIANCE button; the overlay
 * that opens is titled exactly "ALLIANCE" and contains "Donate funds" and
 * a "DONATE" button near the bottom.
 *
 * UNCONFIRMED: there is no screenshot of what happens right after clicking
 * "Donate funds" — whether it's a static label next to an amount field
 * that's already on screen, or something that reveals/focuses a field.
 * This assumes the latter is unnecessary and just locates the nearest real
 * <input> to "Donate funds" by walking up the DOM — a best-effort proximity
 * search, not a verified selector. Flagged loudly (host log + return
 * value) if that assumption turns out wrong.
 * ===================================================================== */
(function () {
  'use strict';

  const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

  function logToHost(message, level) {
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage({ type: 'LOG', level: level || 'info', message: String(message) });
      }
    } catch (_) { /* logging must never break the flow it's reporting on */ }

    if (level === 'error') console.error('[donation] ' + message);
    else if (level === 'warn') console.warn('[donation] ' + message);
    else console.log('[donation] ' + message);
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    if (el.offsetParent === null && style.position !== 'fixed') return false;
    return true;
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

  function directText(el) {
    return [...el.childNodes]
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => n.textContent)
      .join(' ')
      .trim();
  }

  function triggerClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Same generic waiter used across automation.js/ranked.js/big3.js. */
  function waitFor(condition, {
    timeout = 15000,
    interval = 500,
    stableFor = 0,
    label = 'condition',
    root = document.body
  } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      let heldSince = null;
      let settled = false;
      let debounceTimer = null;

      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        if (debounceTimer) clearTimeout(debounceTimer);
        observer.disconnect();
        fn(arg);
      }

      function evaluate() {
        if (settled) return;
        if (Date.now() - start > timeout) {
          finish(reject, new Error(`Timed out waiting for ${label}`));
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

      function scheduleEvaluate() {
        if (debounceTimer || settled) return;
        debounceTimer = setTimeout(() => { debounceTimer = null; evaluate(); }, 50);
      }

      const timer = setInterval(evaluate, interval);
      const observer = new MutationObserver(scheduleEvaluate);
      observer.observe(root, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-disabled']
      });
      evaluate();
    });
  }

  /** Bottom-dock button, same pattern as findDockButton in the other scripts. */
  function findDockButton(label) {
    const vh = window.innerHeight;
    const target = label.toUpperCase().replace(/\s+/g, ' ').trim();
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = directText(el).toUpperCase().replace(/\s+/g, ' ').trim();
      if (t !== target) continue;
      const r = el.getBoundingClientRect();
      if (r.top < vh * 0.75) continue;
      hits.push({ el, area: r.width * r.height });
    }
    if (!hits.length) return null;
    const labelEl = hits.reduce((a, b) => (a.area <= b.area ? a : b)).el;
    return labelEl.closest(CLICKABLE) || labelEl.parentElement || labelEl;
  }

  /**
   * Finds the smallest element whose aggregated text contains both
   * "ALLIANCE" and "DONATE FUNDS" — rather than climbing a fixed number of
   * ancestor levels from the heading, which turned out not deep enough:
   * the real overlay is a much larger layout (sidebar nav, stats panel,
   * buildings, donations feed, donate footer) than the simpler STAMINA
   * TANK modal that climbing approach was built for, so a common ancestor
   * of the heading and the donate footer sits deeper than any fixed cap
   * would reliably reach.
   */
  function findAllianceOverlay() {
    const candidates = [...document.querySelectorAll('body *')].filter(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').toUpperCase();
      // "LEFT TODAY" (from the "...earns you credit · 100M left today."
      // caption), not "DONATE FUNDS" — that label gets REPLACED by
      // whatever's typed into the amount field once it has a value (as
      // confirmed by a screenshot showing "100" where the label used to
      // be), so it isn't present once an amount is already entered. The
      // caption underneath is unaffected either way.
      return text.includes('ALLIANCE') && text.includes('LEFT TODAY') &&
        el.querySelectorAll(CLICKABLE).length > 1;
    });
    if (!candidates.length) return null;
    return candidates.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

  /** Close ("X") button — same pattern as tank.js's findCloseButton. */
  function findCloseButton(root = document) {
    const ariaHit = [...root.querySelectorAll('[aria-label]')].find(el =>
      /close/i.test(el.getAttribute('aria-label') || '') && isVisible(el) && isEnabled(el));
    if (ariaHit) return ariaHit;

    const glyphs = new Set(['×', '✕', '✖', 'X']);
    const glyphHit = [...root.querySelectorAll('body *')].find(el =>
      isVisible(el) && glyphs.has(directText(el).trim()));
    if (glyphHit) return glyphHit.closest(CLICKABLE) || glyphHit;

    return [...root.querySelectorAll('[class*="close" i]')].find(el => isVisible(el) && isEnabled(el)) || null;
  }

  /** Smallest element under `root` whose own text exactly matches `text`. */
  function findByExactText(root, text) {
    const target = text.toUpperCase().trim();
    const hits = [...root.querySelectorAll('*')].filter(el =>
      isVisible(el) && directText(el).toUpperCase().trim() === target);
    if (!hits.length) return null;
    return hits.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

  /**
   * Sets an <input>'s value the way a real React/Vue-controlled input
   * expects — plain `el.value = x` is silently ignored by most JS
   * frameworks, since it bypasses the property setter they patched to
   * track state. Calling the native setter directly, then dispatching
   * input/change, is the standard workaround.
   */
  function setInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /**
   * UNCONFIRMED — nearest real <input> to `anchor`, walking up through
   * ancestors until one contains a visible, enabled text/number input.
   * Falls back to any such input anywhere in the overlay.
   */
  function findNearbyInput(overlay, anchor) {
    const isAmountInput = (el) =>
      isVisible(el) && isEnabled(el) && (el.type === 'text' || el.type === 'number' || !el.type);

    let node = anchor;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const input = [...node.querySelectorAll('input')].find(isAmountInput);
      if (input) return input;
    }
    return [...overlay.querySelectorAll('input')].find(isAmountInput) || null;
  }

  /**
   * Reads "Grows alliance funds + earns you credit · 100M left today." (the
   * hint line under "Donate funds") to check whether donating is available
   * before attempting anything — per explicit instruction, this is the
   * authoritative check, not the DONATE button's own enabled state (which
   * only reflects whether a valid amount has been typed yet, not whether
   * today's allowance is used up). Returns null if the hint text isn't
   * found at all — an unrecognised format doesn't block the attempt, since
   * that's more likely a wording mismatch than a real "no" signal.
   */
  function readDonationAllowance(overlay) {
    const el = [...overlay.querySelectorAll('*')].find(node =>
      isVisible(node) && /LEFT TODAY/i.test(node.textContent || ''));
    if (!el) return null;
    const m = (el.textContent || '').match(/(\d+)\s*M?\s*LEFT TODAY/i);
    return m ? Number(m[1]) : null;
  }

  /**
   * Click ALLIANCE -> open overlay -> check today's allowance -> type the
   * amount directly into the field (no click needed to reveal/focus it) ->
   * click DONATE.
   */
  async function donateToAlliance(amount, { timeout = 15000 } = {}) {
    try {
      const allianceBtn = findDockButton('ALLIANCE');
      if (!allianceBtn) throw new Error('ALLIANCE button not found in the bottom dock.');
      triggerClick(allianceBtn);
      logToHost('Clicked ALLIANCE in the bottom dock.');

      const overlay = await waitFor(() => findAllianceOverlay(), { timeout, label: 'ALLIANCE overlay' });
      logToHost('ALLIANCE overlay open.');

      const allowance = readDonationAllowance(overlay);
      if (allowance === 0) {
        logToHost('Already donated today — nothing left in the daily allowance.');
        return true;
      }
      logToHost(allowance === null
        ? 'Could not read the daily donation allowance — proceeding anyway.'
        : `Daily donation allowance: ${allowance}M left today.`,
        allowance === null ? 'warn' : 'info');

      // No "click Donate funds" step — per explicit confirmation, the
      // amount field is already present and typeable without it; that
      // label is purely decorative text next to the field, not something
      // that needs clicking to reveal or focus it.
      const donateBtnText = await waitFor(() => findByExactText(overlay, 'DONATE'),
        { timeout, label: 'DONATE button', root: overlay });
      const donateBtn = donateBtnText.closest(CLICKABLE) || donateBtnText;

      const input = await waitFor(() => findNearbyInput(overlay, donateBtnText),
        { timeout, label: 'donation amount field', root: overlay });
      setInputValue(input, String(amount));
      logToHost(`Entered donation amount: ${amount}`);
      await sleep(400);

      triggerClick(donateBtn);
      logToHost(`Clicked DONATE — donated ${amount}.`);

      await sleep(800);
      const closeBtn = findCloseButton(overlay);
      if (closeBtn) {
        triggerClick(closeBtn);
        logToHost('Closed the ALLIANCE overlay.');
      } else {
        logToHost('Could not find the ALLIANCE overlay close (X) button.', 'warn');
      }

      return true;
    } catch (err) {
      logToHost(`donateToAlliance() failed: ${err.message}`, 'error');
      return false;
    }
  }

  window.donateToAlliance = (amount) => donateToAlliance(amount != null ? amount : 100);
})();
