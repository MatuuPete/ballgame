/* =====================================================================
 * tasks.js — Alliance task-reward claiming helper.
 *
 * Flow: click TASKS in the bottom dock -> the Tasks overlay opens -> wait
 * 1s -> click "CLAIM ALL REWARDS (n)" -> click the overlay's close (X)
 * button.
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

    if (level === 'error') console.error('[tasks] ' + message);
    else if (level === 'warn') console.warn('[tasks] ' + message);
    else console.log('[tasks] ' + message);
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

  /** Same generic waiter used across automation.js/ranked.js/big3.js/donation.js/tank.js. */
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

  /** Close ("X") button — same pattern as tank.js/donation.js's findCloseButton. */
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

  /**
   * Smallest element whose aggregated text contains both "TASKS" (the
   * overlay heading) and "COMPLETE" (from the "11/42 COMPLETE" progress
   * line) — same "smallest element containing both signals" approach used
   * for the Alliance and Stamina Tank overlays, since those two pieces of
   * text stay put regardless of which reward category is selected.
   */
  function findTasksOverlay() {
    const candidates = [...document.querySelectorAll('body *')].filter(el => {
      if (!isVisible(el)) return false;
      const text = (el.textContent || '').toUpperCase();
      return text.includes('TASKS') && text.includes('COMPLETE') &&
        el.querySelectorAll(CLICKABLE).length > 1;
    });
    if (!candidates.length) return null;
    return candidates.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

  /**
   * Resolves a matched text/label element to the actual control it lives
   * inside — a real <button>/<a>/role="button" if one exists in its
   * ancestor chain, otherwise the nearest ancestor that isn't
   * pointer-events:none. Same fallback proven for FILL TANK/PLAN/PLAY GAME
   * elsewhere in this app, for the same reason: the click handler often
   * lives on a styled <div> wrapper, not a semantic control.
   */
  function resolveControl(el, maxDepth = 5) {
    const clickableAncestor = el.closest(CLICKABLE);
    if (clickableAncestor) return clickableAncestor;

    let control = el;
    for (let node = el, depth = 0; node && depth < maxDepth; node = node.parentElement, depth++) {
      if (getComputedStyle(node).pointerEvents !== 'none') { control = node; break; }
    }
    return control;
  }

  /**
   * "CLAIM ALL REWARDS (n)" — the count changes as tasks become ready, so
   * this matches on the constant prefix. Uses aggregated .textContent, not
   * directText() — the label is almost certainly split across styled child
   * spans (same failure mode as FILL TANK's "FILL TANK - +960 STA"), so no
   * single element's OWN direct text ever contains the whole string.
   */
  function findClaimRewardsButton(overlay) {
    const target = 'CLAIM ALL REWARDS';
    const hits = [...overlay.querySelectorAll('*')].filter(el =>
      isVisible(el) && (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim().startsWith(target));
    if (!hits.length) return null;
    const labelEl = hits.reduce((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return (ra.width * ra.height) <= (rb.width * rb.height) ? a : b;
    });
    return resolveControl(labelEl);
  }

  /**
   * Click TASKS -> open overlay -> wait 1s -> click CLAIM ALL REWARDS ->
   * click the overlay's close (X) button.
   */
  async function claimAllianceTasks({ timeout = 15000 } = {}) {
    try {
      const tasksBtn = findDockButton('TASKS');
      if (!tasksBtn) throw new Error('TASKS button not found in the bottom dock.');
      triggerClick(tasksBtn);
      logToHost('Clicked TASKS in the bottom dock.');

      const overlay = await waitFor(() => findTasksOverlay(), { timeout, label: 'TASKS overlay' });
      logToHost('TASKS overlay open.');

      await sleep(2500);

      // No isEnabled() gate — its className regex reads Tailwind variant
      // classes like "disabled:opacity-50" as a real disabled state (same
      // false positive confirmed on FILL TANK). A genuinely disabled
      // control just no-ops on a synthetic click, so it's safe to always
      // attempt it once the button is found.
      const claimBtn = findClaimRewardsButton(overlay);
      if (!claimBtn) {
        logToHost('No "CLAIM ALL REWARDS" button found — nothing ready to claim.');
      } else {
        triggerClick(claimBtn);
        logToHost('Clicked CLAIM ALL REWARDS.');
        await sleep(500);
      }

      const closeBtn = findCloseButton(overlay);
      if (closeBtn) {
        triggerClick(closeBtn);
        logToHost('Closed the TASKS overlay.');
      } else {
        logToHost('Could not find the TASKS overlay close (X) button.', 'warn');
      }

      return true;
    } catch (err) {
      logToHost(`claimAllianceTasks() failed: ${err.message}`, 'error');
      return false;
    }
  }

  window.claimAllianceTasks = () => claimAllianceTasks();
})();
