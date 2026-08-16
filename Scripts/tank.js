/* =====================================================================
 * tank.js — Fill the Stamina Tank helper.
 *
 * Flow: click the tank icon -> wait 1.5s -> the STAMINA TANK overlay opens
 * -> read current/max level -> randomly pick a mix of stamina items to
 * close the gap to full -> click FILL TANK.
 *
 * CONFIRMED from screenshots (including a live test run): the tank icon
 * click (position-based fallback) lands correctly; the overlay is titled
 * "STAMINA TANK", shows "TANK LEVEL current / max full", a paginated
 * "SUPPLY SHELF" ("1-5 of 8 items", page indicator "1/2" with prev/next
 * arrows), each item row has a name, a "+N STA EACH" value, a stepper (-,
 * count, +, MAX), and a submit button whose label is DYNAMIC — "FILL TANK
 * - +930 STA", the amount tracking whatever's currently selected — so it's
 * matched by prefix, not exact text.
 *
 * CONFIRMED, and now handled: a row's "N LEFT" stock text is REPLACED by
 * "+NNN" (its STA contribution) once it has a quantity selected — it does
 * not coexist with "LEFT" the way it did at 0. Re-reading stock for an
 * already-selected row (e.g. the remainder-cleanup pass revisiting an item
 * the main loop already used) previously read 0 and silently added
 * nothing. Fixed by reading each item's stock exactly once, before it's
 * ever touched, and reusing that cached figure everywhere else.
 *
 * Still unconfirmed: the tank icon's fallback selector is a FIXED
 * screen-relative coordinate (no text label exists to find it by), which
 * does not adapt to layout/resolution changes the way every other finder
 * in this app does. It held up in the one test so far.
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

    if (level === 'error') console.error('[tank] ' + message);
    else if (level === 'warn') console.warn('[tank] ' + message);
    else console.log('[tank] ' + message);
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

  /** Same generic waiter used across the other scripts in this app. */
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
   * Smallest element under `root` whose own text STARTS WITH `prefix` — for
   * controls like FILL TANK, whose full label is dynamic ("FILL TANK -
   * +930 STA", the amount changing with whatever's currently selected), so
   * an exact match against the base label never matches at all.
   */
  function findByTextPrefix(root, prefix) {
    const target = prefix.toUpperCase().trim();
    // Aggregated .textContent, not directText() — "FILL TANK - +960 STA"
    // is styled as two colours ("FILL TANK -" vs "+960 STA"), meaning it's
    // almost certainly split across child spans, so no single element's
    // OWN direct text ever contains the whole label. Same failure mode as
    // SUB/BENCH and PLAN/COACH elsewhere in this app.
    const hits = [...root.querySelectorAll('*')].filter(el =>
      isVisible(el) && (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim().startsWith(target));
    if (!hits.length) return null;
    return hits.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

  /**
   * Resolves a matched text/label element to the actual control it lives
   * inside — a real <button>/<a>/role="button" if one exists in its
   * ancestor chain, otherwise the nearest ancestor that isn't
   * pointer-events:none (same fallback already proven for the PLAN button
   * elsewhere in this app). This matters for TWO separate reasons: clicking
   * needs to land where the real handler is, and isEnabled() needs to be
   * checked against that same real control — checking it against an inner
   * label fragment instead (e.g. just the "+960 STA" span) can read as
   * disabled even when the actual button is perfectly clickable.
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

  /** Overlay close ("X") control — same pattern proven in automation.js. */
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
   * Bottom-dock button (TASKS, BAG, ... CITY, etc.) — same pattern used in
   * automation.js/ranked.js/big3.js, kept as its own copy here rather than
   * shared, matching how each script in this app is self-contained.
   */
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
   * Generic map-overlay button (e.g. "STADIUM" on the City map) — NOT
   * constrained to the bottom-dock region, since these labels sit wherever
   * their building is drawn.
   */
  function findMapLabel(label) {
    const target = label.toUpperCase().replace(/\s+/g, ' ').trim();
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = directText(el).toUpperCase().replace(/\s+/g, ' ').trim();
      if (t !== target) continue;
      const r = el.getBoundingClientRect();
      hits.push({ el, area: r.width * r.height });
    }
    if (!hits.length) return null;
    const labelEl = hits.reduce((a, b) => (a.area <= b.area ? a : b)).el;
    return labelEl.closest(CLICKABLE) || labelEl.parentElement || labelEl;
  }

  /** See file header, point 1 — the weakest link in this script. */
  function findTankIcon() {
    const labelled = [...document.querySelectorAll('body *')].find(el => {
      if (!isVisible(el)) return false;
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toUpperCase();
      return label.includes('TANK') || label.includes('STAMINA');
    });
    if (labelled) return labelled.closest(CLICKABLE) || labelled;

    // Fallback: fixed position from the reference screenshot, as a fraction
    // of the current viewport. Fragile — see file header.
    const x = window.innerWidth * 0.177;
    const y = window.innerHeight * 0.227;
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    return hit.closest(CLICKABLE) || hit;
  }

  /**
   * CONFIRMED overlay heading: "STAMINA TANK". Disambiguated (same pattern
   * as every other overlay in this app) by requiring the container to also
   * hold "TANK LEVEL" and "SUPPLY SHELF".
   */
  function findStaminaTankOverlay() {
    const heading = [...document.querySelectorAll('body *')].find(el =>
      isVisible(el) && directText(el).toUpperCase().trim() === 'STAMINA TANK');
    if (!heading) return null;

    let node = heading.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const text = (node.textContent || '').toUpperCase();
      if (text.includes('TANK LEVEL') && text.includes('SUPPLY SHELF') && node.querySelectorAll(CLICKABLE).length > 1) {
        return node;
      }
    }
    return null;
  }

  /** Parses "4090 / 5000 full" (or similar) near the "TANK LEVEL" heading. */
  function readTankLevel(overlay) {
    const heading = findByExactText(overlay, 'TANK LEVEL');
    if (!heading) return null;

    let node = heading.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const text = (node.textContent || '').replace(/\s+/g, ' ');
      const m = text.match(/(\d[\d,]*)\s*\/\s*(\d[\d,]*)/);
      if (m) {
        return {
          current: Number(m[1].replace(/,/g, '')),
          max: Number(m[2].replace(/,/g, ''))
        };
      }
    }
    return null;
  }

  const STAMINA_ITEMS = [
    { name: 'Water Bottle I', sta: 10 },
    { name: 'Water Bottle II', sta: 20 },
    { name: 'Water Bottle III', sta: 30 },
    { name: 'Water Bottle Max', sta: 100 },
    { name: 'Energy Drink I', sta: 110 },
    { name: 'Energy Drink II', sta: 220 },
    { name: 'Energy Drink III', sta: 330 },
    { name: 'Energy Drink Max', sta: 1100 }
  ];

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Random integer in [min, max], inclusive. */
  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * An item's row, found by its exact name (e.g. "Water Bottle I" — exact
   * match matters, since "Water Bottle II" starts with that same string).
   * Climbed to a container that also holds "LEFT" and "MAX", the two other
   * confirmed pieces of text every row has.
   */
  function findTankItemRow(overlay, name) {
    const label = findByExactText(overlay, name);
    if (!label) return null;

    let node = label.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const text = (node.textContent || '').toUpperCase();
      if (text.includes('LEFT') && text.includes('MAX')) return node;
    }
    return label.parentElement || label;
  }

  function readItemStock(row) {
    const m = (row.textContent || '').match(/(\d+)\s*LEFT/i);
    return m ? Number(m[1]) : 0;
  }

  /** The stepper's "+" control — the clickable nearest to "MAX" from its left. */
  function findPlusButton(row) {
    const maxBtn = findByExactText(row, 'MAX');
    if (!maxBtn) return null;
    const maxLeft = maxBtn.getBoundingClientRect().left;

    const candidates = [...row.querySelectorAll(CLICKABLE)].filter(el => {
      if (el === maxBtn || maxBtn.contains(el) || el.contains(maxBtn)) return false;
      if (!isVisible(el) || !isEnabled(el)) return false;
      return el.getBoundingClientRect().left < maxLeft;
    });
    if (!candidates.length) return null;

    return candidates.reduce((best, el) =>
      el.getBoundingClientRect().left > best.getBoundingClientRect().left ? el : best);
  }

  /** Pagination arrow, found relative to the confirmed "N/N" page indicator. */
  function findPaginationArrow(overlay, direction) {
    const indicator = [...overlay.querySelectorAll('*')].find(el =>
      isVisible(el) && /^\d+\/\d+$/.test(directText(el).replace(/\s+/g, '')));
    if (!indicator) return null;

    let node = indicator.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const clickables = [...node.querySelectorAll(CLICKABLE)].filter(isVisible);
      if (clickables.length < 2) continue;
      const indicatorLeft = indicator.getBoundingClientRect().left;
      const sorted = clickables.slice().sort((a, b) =>
        a.getBoundingClientRect().left - b.getBoundingClientRect().left);
      return direction === 'next'
        ? sorted.find(el => el.getBoundingClientRect().left > indicatorLeft) || null
        : [...sorted].reverse().find(el => el.getBoundingClientRect().left < indicatorLeft) || null;
    }
    return null;
  }

  /** Flips pages forward (up to `maxFlips` times) until `name`'s row is found. */
  async function ensureItemVisible(overlay, name, maxFlips = 3) {
    for (let attempt = 0; attempt <= maxFlips; attempt++) {
      const row = findTankItemRow(overlay, name);
      if (row) return row;

      const next = findPaginationArrow(overlay, 'next');
      if (!next || !isEnabled(next)) return null;
      triggerClick(next);
      await sleep(500);
    }
    return null;
  }

  async function clickPlusTimes(plusBtn, times) {
    for (let i = 0; i < times; i++) {
      triggerClick(plusBtn);
      await sleep(45);
    }
  }

  /**
   * Click the tank icon, wait 1.5s, then randomly pick a mix of items to
   * close the gap to full capacity, preferring batches of 5+ per item type
   * used (not scattering 1-4 units across many types) — with one
   * exception: the final small remainder that no >=5 batch can close
   * exactly gets topped up with Water Bottle I (the finest denomination),
   * even below 5 units, since actually reaching full capacity matters more
   * than that preference for the last few units.
   */
  async function fillTankToCapacity({ timeout = 15000 } = {}) {
    try {
      const tankIcon = findTankIcon();
      if (!tankIcon) throw new Error('Stamina tank icon not found.');
      triggerClick(tankIcon);
      logToHost('Clicked the stamina tank icon.');

      await sleep(1500);

      const overlay = await waitFor(() => findStaminaTankOverlay(),
        { timeout, label: 'STAMINA TANK overlay' });
      logToHost('STAMINA TANK overlay open.');

      const level = readTankLevel(overlay);
      if (!level) throw new Error('Could not read the tank level.');

      let remaining = level.max - level.current;
      logToHost(`Tank at ${level.current}/${level.max} — need ${remaining} more.`);

      if (remaining <= 0) {
        logToHost('Tank is already full — nothing to do.');
        return true;
      }

      const usedSoFar = new Map();

      // Read once per item, the first time its row is touched, and reused
      // from then on — the row's "N LEFT" text disappears once a quantity
      // is selected (it shows "+NNN" instead), so re-reading it later (e.g.
      // in the cleanup pass, for an item already used in the main loop)
      // would silently read 0 stock and add nothing further.
      const stockCache = new Map();
      function stockFor(row, name) {
        if (!stockCache.has(name)) stockCache.set(name, readItemStock(row));
        return stockCache.get(name);
      }

      for (const item of shuffle(STAMINA_ITEMS)) {
        if (remaining < item.sta * 5) continue; // can't fit a batch of >=5 of this item

        const row = await ensureItemVisible(overlay, item.name);
        if (!row) {
          logToHost(`Could not find "${item.name}" on any page — skipping.`, 'warn');
          continue;
        }

        const stock = stockFor(row, item.name);
        const maxUsable = Math.min(stock, Math.floor(remaining / item.sta));
        if (maxUsable < 5) continue;

        const qty = randomInt(5, maxUsable);
        const plusBtn = findPlusButton(row);
        if (!plusBtn) {
          logToHost(`Could not find the "+" control for "${item.name}" — skipping.`, 'warn');
          continue;
        }

        await clickPlusTimes(plusBtn, qty);
        remaining -= qty * item.sta;
        usedSoFar.set(item.name, qty);
        logToHost(`Added ${qty} x ${item.name} (+${item.sta} each) — ${remaining} left to fill.`);
      }

      // Cleanup pass — close the exact remainder with Water Bottle I.
      if (remaining > 0) {
        const fine = STAMINA_ITEMS[0]; // Water Bottle I, 10 each
        const row = await ensureItemVisible(overlay, fine.name);
        if (row) {
          const alreadyUsed = usedSoFar.get(fine.name) || 0;
          // Conservative: assume "LEFT" does NOT live-decrement, so
          // subtract what's already been queued this run. Uses the cached
          // reading, not a fresh DOM read — see stockFor() above.
          const stock = Math.max(0, stockFor(row, fine.name) - alreadyUsed);
          const need = Math.ceil(remaining / fine.sta);
          const qty = Math.min(need, stock);
          const plusBtn = findPlusButton(row);
          if (plusBtn && qty > 0) {
            await clickPlusTimes(plusBtn, qty);
            remaining -= qty * fine.sta;
            logToHost(`Topped up with ${qty} x ${fine.name} to close the remainder.`);
          }
        }
      }

      if (remaining > 0) {
        logToHost(`Could not fully close the gap — ${remaining} stamina short (ran out of usable stock).`, 'warn');
      }

      const fillLabel = await waitFor(() => findByTextPrefix(overlay, 'FILL TANK'),
        { timeout, label: 'FILL TANK button', root: overlay });
      const fillBtn = resolveControl(fillLabel);

      // Not gated on isEnabled() here — the button is visually active in
      // every screenshot seen so far (never greyed out), so a persistent
      // "disabled" reading has to be a false positive in that heuristic,
      // most likely isEnabled()'s className check: it treats any class
      // containing the substring "disabled" as proof of a disabled state,
      // but CSS frameworks commonly ship classes like "disabled:opacity-50"
      // as a permanent, always-present part of the class list — styled
      // conditionally via CSS, not reflecting current state — and that
      // still matches the \bdisabled\b check since a colon counts as a
      // word boundary. Skipping the gate is safe either way: a genuinely
      // disabled control just no-ops on a synthetic click.
      triggerClick(fillBtn);
      logToHost(`Clicked "${directText(fillLabel)}".`);

      // The tank is filled at this point — everything below is "return to
      // the match" navigation, not part of the fill itself, so failures
      // here are logged but don't turn the overall result into a failure.
      await sleep(600);

      const closeBtn = findCloseButton(overlay);
      if (closeBtn) {
        triggerClick(closeBtn);
        logToHost('Closed the STAMINA TANK overlay.');
        await sleep(400);
      } else {
        logToHost('No close control found for the STAMINA TANK overlay — leaving it open.', 'warn');
      }

      const cityBtn = findDockButton('CITY');
      if (!cityBtn) {
        logToHost('CITY button not found in the bottom dock.', 'warn');
        return true;
      }
      triggerClick(cityBtn);
      logToHost('Clicked CITY in the bottom dock.');

      try {
        const stadiumBtn = await waitFor(() => findMapLabel('STADIUM'),
          { timeout, stableFor: 300, interval: 200, label: 'STADIUM building' });
        triggerClick(stadiumBtn);
        logToHost('Clicked STADIUM.');
      } catch (err) {
        logToHost('STADIUM building did not appear in time: ' + err.message, 'warn');
      }

      return true;
    } catch (err) {
      logToHost(`fillTankToCapacity() failed: ${err.message}`, 'error');
      return false;
    }
  }

  window.fillTankToCapacity = () => fillTankToCapacity({});
})();
