(function () {
  const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
  const MAX_REWARDS = 100;
  const MORALE_THRESHOLD = 45;
  const MAX_TIMEOUTS_PER_MATCH = 2;
  const DEFEAT_DELAY = 4000;
  const MAX_SEASON_GAMES = 3;

  // Exact prop list used by enemy / inventory.
  // Order does NOT matter for detection — matching is exact-first, then
  // longest-substring-wins (see bestPropMatch), so tiered names like the
  // Energy Drink family can't shadow each other.
  const ENEMY_PROPS = [
    "ENERGY DRINK I",
    "ENERGY DRINK II",
    "ENERGY DRINK III",
    "ENERGY DRINK MAX",
    "BOO CARD",
    "CHEER CARD",
    "ROAR CARD",
    "STRATEGY SCOUT"
  ];

  // ==================== HOST BRIDGE ====================
  // window.__wpf is installed by bridge.js before this script runs.
  // Falls back to a no-op so this file still works if run standalone
  // (e.g. pasted into DevTools) without a WPF host listening.
  const bridge = (typeof window !== 'undefined' && window.__wpf) || { send() {}, status() {} };

  // ==================== DOM HELPERS ====================

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    // Cheapest check first — a zero-size box is invisible regardless of
    // style, so this short-circuits the getComputedStyle() call below for
    // most of the "body *" scan without changing what counts as visible.
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

  function ownText(el) {
    const raw = directText(el) || el.value || el.textContent || '';
    return raw.trim().toUpperCase().replace(/\s+/g, ' ');
  }

  // Like textContent, but guarantees a space between text from separate
  // child nodes/elements. Plain .textContent can glue adjacent nested
  // spans together with no whitespace at all (e.g. a button laid out as
  // "TO" / "2 LEFT" on two lines can textContent to "TO2 LEFT"), which
  // breaks any exact- or word-boundary match against "TO".
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

  // Dispatches full mouse event cycle for UI frameworks that ignore standard .click()
  function triggerClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function findByLabel(label, root = document) {
    const target = label.toUpperCase();
    return [...root.querySelectorAll(CLICKABLE)].find(el => {
      const text = ownText(el);
      return (text === target || text.split(' ').includes(target)) && isVisible(el) && isEnabled(el);
    }) || null;
  }

  function findByContains(phrase, root = document) {
    const target = phrase.toUpperCase();
    return [...root.querySelectorAll(CLICKABLE)].find(el =>
      (el.textContent || '').toUpperCase().includes(target) && isVisible(el) && isEnabled(el)
    ) || null;
  }

  function findTab(label) {
    const target = label.toUpperCase();
    const selector = `${CLICKABLE}, li, span, div`;
    return [...document.querySelectorAll(selector)].find(el => {
      const own = directText(el).toUpperCase().replace(/\s+/g, ' ');
      return own === target && isVisible(el);
    }) || null;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ==================== REWARDS COUNTER ====================

  function readRewardsCounter() {
    const PATTERN = /\b(\d{1,3})\s*\/\s*(\d{1,3})\b/;
    const candidates = [...document.querySelectorAll('body *')].filter(el => {
      if (!isVisible(el)) return false;
      const own = directText(el);
      if (!own) return false;
      const m = own.match(PATTERN);
      return m && Number(m[2]) === MAX_REWARDS;
    });

    if (!candidates.length) return null;

    const scored = candidates.map(el => ({
      el,
      isRewards: (el.parentElement?.textContent || '').toUpperCase().includes('REWARD')
    }));
    const chosen = (scored.find(s => s.isRewards) || scored[0]).el;

    const [, cur, tot] = directText(chosen).match(PATTERN);
    const current = Number(cur);
    const total = Number(tot);
    return { current, total, remaining: Math.max(0, total - current) };
  }

  // ==================== SEASON HELPERS ====================

  function findPlayGameButton() {
    // 1. Original strict match: "PLAY GAME" + number (e.g. "PLAY GAME 1")
    let btn = [...document.querySelectorAll(CLICKABLE)].find(el => {
      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      return /^PLAY GAME\s*\d+/.test(text) && isVisible(el);
    });
    if (btn) return btn;

    // 2. Fallback for the Season playoffs button (the one circled in the image)
    //    Handles slight text variations, arrows, or extra characters
    return [...document.querySelectorAll(CLICKABLE)].find(el => {
      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      return (
        (text.includes('PLAY GAME') || /^PLAY\s*GAME/.test(text)) &&
        isVisible(el) &&
        isEnabled(el)
      );
    }) || null;
  }

  function readDailyGamesLeft() {
    const el = [...document.querySelectorAll('body *')].find(node => {
      if (!isVisible(node)) return false;
      const own = directText(node).toUpperCase();
      return /\d+\s+DAILY GAMES? LEFT/.test(own);
    });

    if (!el) return null;
    const m = directText(el).toUpperCase().match(/(\d+)\s+DAILY GAMES? LEFT/);
    return m ? Number(m[1]) : null;
  }

  async function switchToTab(tabName) {
    const tab = findTab(tabName);
    if (!tab) {
      console.warn(`  ⚠️ "${tabName}" tab not found`);
      return false;
    }
    triggerClick(tab);
    console.log(`  🗂️ Switched to ${tabName} tab`);
    await sleep(1200);
    return true;
  }

  // ==================== SCOREBOARD / MORALE ====================

  function readOpponentMorale() {
    const labels = [...document.querySelectorAll('body *')].filter(
      el => isVisible(el) && directText(el).toUpperCase() === 'MORALE'
    );

    if (!labels.length) return null;

    const readings = [];
    for (const label of labels) {
      let value = null;
      let node = label.parentElement;
      for (let depth = 0; node && depth < 4 && value === null; depth++, node = node.parentElement) {
        const nums = [...node.querySelectorAll('*')]
          .filter(el => isVisible(el))
          .map(el => directText(el).trim())
          .filter(t => /^\d{1,3}$/.test(t))
          .map(Number)
          .filter(n => n >= 0 && n <= 100);
        if (nums.length) value = nums[0];
      }
      if (value === null) continue;
      const rect = label.getBoundingClientRect();
      readings.push({ value, centerX: rect.left + rect.width / 2 });
    }

    if (!readings.length) return null;
    readings.sort((a, b) => b.centerX - a.centerX);
    return readings[0].value;
  }

  // ==================== POST-GAME RESULT ====================

  function readMatchResult() {
    const banner = [...document.querySelectorAll('body *')].find(el => {
      if (!isVisible(el)) return false;
      const own = directText(el).toUpperCase().replace(/[^A-Z]/g, '');
      return own === 'VICTORY' || own === 'DEFEAT';
    });
    if (!banner) return null;
    return directText(banner).toUpperCase().replace(/[^A-Z]/g, '');
  }

  // ==================== GENERIC WAITER ====================
  //
  // Driven by a MutationObserver (reacts to real DOM changes) plus a slow
  // interval as a backstop for changes an observer cannot see (a class
  // being recomputed, an animation finishing). Observer firings are
  // coalesced with a short debounce so a burst of mutations — common on a
  // busy, animated match page — runs condition() once instead of once per
  // mutation; condition() itself scans large chunks of the DOM, so calling
  // it less often is what keeps this cheap with several matches running
  // in parallel across windows.
  function waitFor(condition, {
    timeout = 6 * 60 * 1000,
    interval = 500,
    stableFor = 0,
    label = 'condition'
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
        const result = condition();
        if (!result) { heldSince = null; return; }
        if (stableFor > 0) {
          if (heldSince === null) { heldSince = Date.now(); return; }
          if (Date.now() - heldSince < stableFor) return;
        }
        finish(resolve, result);
      }

      // Collapses a burst of same-tick observer firings into one evaluate().
      function scheduleEvaluate() {
        if (debounceTimer || settled) return;
        debounceTimer = setTimeout(() => { debounceTimer = null; evaluate(); }, 50);
      }

      const timer = setInterval(evaluate, interval);
      const observer = new MutationObserver(scheduleEvaluate);
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-disabled']
      });
      evaluate();
    });
  }

  // ==================== PROP DETECTION & AUTO-COUNTER ====================

  /**
   * Given normalized banner text, returns the single best matching entry
   * from ENEMY_PROPS: an exact match always wins; otherwise the LONGEST
   * substring match wins. This is what stops "ENERGY DRINK I" (a literal
   * text-prefix of "ENERGY DRINK II" / "ENERGY DRINK III" / "ENERGY DRINK
   * MAX") from shadowing the real, more specific prop that's actually
   * active — and it applies the same way to any prop, tiered or not, so it
   * doesn't need special-casing per prop family (Energy Drink, Water
   * Bottle, or anything added later).
   */
  function bestPropMatch(text) {
    const exact = ENEMY_PROPS.find(p => text === p);
    if (exact) return exact;
    const subs = ENEMY_PROPS.filter(p => text.includes(p));
    if (!subs.length) return null;
    return subs.reduce((a, b) => (b.length > a.length ? b : a));
  }

  /**
   * Scans for the central pop balloon announcing an opponent prop use.
   */
  function readActivePropBanner() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const matches = [];

    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;

      // Full textContent (not just direct text nodes) so a name rendered
      // across nested spans/icons — as ROAR CARD / BOO CARD / CHEER CARD
      // banners may be — still gets picked up, not just plain-text ones.
      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const prop = bestPropMatch(text);
      if (!prop) continue;

      const rect = el.getBoundingClientRect();
      // Strictly bounds checking center 50% of screen
      const inCenterY = rect.top > (vh * 0.25) && rect.bottom < (vh * 0.75);
      const inCenterX = rect.left > (vw * 0.25) && rect.right < (vw * 0.75);
      if (inCenterY && inCenterX) {
        matches.push({ prop, area: rect.width * rect.height });
      }
    }

    if (!matches.length) return null;
    // If more than one element in the center zone matches (e.g. an outer
    // wrapper and its inner label both contain the text), prefer whichever
    // is the smallest/most specific — avoids one broad match accidentally
    // picking up leftover text from something else on screen.
    return matches.reduce((best, m) => (m.area < best.area ? m : best)).prop;
  }

  /**
   * Finds a dedicated "close" control for an open modal/panel — an aria-label
   * of "close", or a small clickable glyph (×, ✕, ⨯, X). Do NOT assume the
   * button that opened the panel (e.g. "PROP") also closes it on re-click —
   * that's frequently a one-way "open" action, not a toggle, and re-clicking
   * it leaves the panel stuck open forever.
   */
  function findCloseButton(root = document) {
    const ariaHit = [...root.querySelectorAll('[aria-label]')].find(el =>
      /close/i.test(el.getAttribute('aria-label') || '') && isVisible(el) && isEnabled(el)
    );
    if (ariaHit) return ariaHit;

    const glyphs = new Set(['×', '✕', '⨯', 'X']);
    const glyphHit = [...root.querySelectorAll('body *')].find(el =>
      isVisible(el) && glyphs.has(ownText(el))
    );
    if (glyphHit) return glyphHit.closest(CLICKABLE) || glyphHit;

    return [...root.querySelectorAll('[class*="close" i]')].find(el => isVisible(el) && isEnabled(el)) || null;
  }

  /**
   * Closes the PROP BAG panel via its actual close control. Falls back to
   * re-clicking PROP only if no dedicated close button can be found.
   */
  async function closePropMenu(propBtn) {
    const closeBtn = findCloseButton();
    if (closeBtn) {
      triggerClick(closeBtn);
      console.log('  ✔️ Closed PROP menu via close button');
      await sleep(400);
      return true;
    }
    console.warn('  ⚠️ No dedicated close button found — falling back to re-clicking PROP');
    if (propBtn) triggerClick(propBtn);
    await sleep(400);
    return false;
  }

  /**
   * Opens Control Deck -> Selects matching prop in inventory -> Confirms deployment
   */
  async function counterEnemyProp(propName) {
    console.log(`  🚨 Center balloon detected: [${propName}] — Executing counter!`);

    const propBtn = findByLabel('PROP') || findByContains('PROP UTILITY') || findByContains('PROP');
    if (!propBtn) {
      console.warn('  ⚠️ PROP button not found in Control Deck');
      return false;
    }

    triggerClick(propBtn);
    console.log('  🗃️ Opened PROP menu');
    await sleep(500); // Allow modal animation to render items

    const baseName = propName.replace(/\s*(I|II|III|IV|V|MAX|\d+)$/i, '').trim();

    // Picks the most specific (deepest/smallest) matching element instead of
    // the first DOM-order match, which is very often a container/wrapper that
    // merely *contains* the real card (since .textContent includes descendants).
    function mostSpecificMatch(candidates) {
      if (!candidates.length) return null;
      // Drop any candidate that is an ancestor of another candidate.
      const leaves = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
      const pool = leaves.length ? leaves : candidates;
      // Among remaining candidates, the real card is the smallest bounding box.
      return pool.reduce((best, el) => {
        if (!best) return el;
        const a = el.getBoundingClientRect();
        const b = best.getBoundingClientRect();
        return (a.width * a.height) < (b.width * b.height) ? el : best;
      }, null);
    }

    let targetProp = null;
    try {
      targetProp = await waitFor(
        () => {
          const items = [...document.querySelectorAll('body *')].filter(el => isVisible(el) && isEnabled(el));

          // 1. Try exact prop match
          let candidates = items.filter(el => (el.textContent || '').toUpperCase().includes(propName));
          let match = mostSpecificMatch(candidates);

          // 2. Fallback to base prop match (e.g., if enemy uses Energy Drink II and you have Energy Drink I)
          if (!match) {
            candidates = items.filter(el => {
              const txt = (el.textContent || '').toUpperCase();
              return txt.includes(baseName) && !txt.includes('CONTROL DECK');
            });
            match = mostSpecificMatch(candidates);
          }
          return match;
        },
        { timeout: 3000, interval: 200, label: `Inventory item matching ${propName}` }
      );
    } catch {
      console.warn(`  ⚠️ Could not find [${propName}] or [${baseName}] in inventory deck.`);
      await closePropMenu(propBtn);
      return false;
    }

    triggerClick(targetProp);
    console.log(`  🎯 Clicked prop card in inventory: [${targetProp.textContent.trim().slice(0, 30)}]`);
    await sleep(600);

    const confirm = findByLabel('CONFIRM') || findByLabel('USE') || findByLabel('APPLY') || findByContains('CONFIRM');
    if (confirm) {
      triggerClick(confirm);
      console.log('  ✔️ Counter prop confirmed & deployed!');
      return true;
    }

    // No confirm step appeared — the click likely landed on a wrapper rather
    // than the actual card, so nothing was armed. Report failure honestly
    // instead of silently claiming success.
    console.warn('  ⚠️ No CONFIRM/USE/APPLY control appeared — prop was NOT deployed.');
    await closePropMenu(propBtn);
    return false;
  }

  // ==================== CONTROL DECK ACTIONS ====================

  // Scoped to the bottom-right Control Deck quadrant (where TO/SUB/PLAN/PROP
  // live in the layout) and requires "TO" as a standalone word in deepText.
  // This avoids two failure modes of a plain findByLabel/findByContains('TO'):
  //  1. False negative — a button rendered as "TO" + "2 LEFT" on separate
  //     child spans can textContent to "TO2 LEFT" with no space, which
  //     never equals "TO" and never contains "TO" as its own word.
  //  2. False positive — a bare substring search for "TO" can match the
  //     first *any* clickable element elsewhere on the page whose text
  //     happens to contain "TO" (e.g. "AUTO", "STORE"), not just this button.
  function findTimeoutButton() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const candidates = [...document.querySelectorAll(CLICKABLE)].filter(el => {
      if (!isVisible(el) || !isEnabled(el)) return false;
      if (!/\bTO\b/.test(deepText(el))) return false;
      const rect = el.getBoundingClientRect();
      return rect.left > vw * 0.5 && rect.top > vh * 0.5; // Control Deck corner
    });
    if (!candidates.length) return null;
    // Smallest matching element wins — the actual button, not an outer wrapper
    return candidates.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

  // Returns a status string instead of a plain boolean so the caller can
  // tell "couldn't find the button yet, worth retrying" apart from
  // "found it, but 0 charges left — stop trying". Losing that distinction
  // was the main bug: any failed attempt used to permanently give up for
  // the rest of the match instead of retrying on the next tick.
  async function callTimeout() {
    const toBtn = findTimeoutButton();
    if (!toBtn) {
      console.warn('  ⚠️ TO button not found in Control Deck this tick');
      return 'no-button';
    }

    const label = deepText(toBtn);
    const leftMatch = label.match(/(\d+)\s*LEFT/);
    if (leftMatch && Number(leftMatch[1]) === 0) {
      console.warn('  ⚠️ TO button found but 0 timeouts left');
      return 'no-charges';
    }

    triggerClick(toBtn);
    console.log('  ⏱️ Timeout called');
    await sleep(700);

    const confirm = findByLabel('CONFIRM') || findByLabel('USE') || findByLabel('YES');
    if (confirm) triggerClick(confirm);
    return 'clicked';
  }

  // ==================== IN-MATCH MONITOR ====================

  function startInMatchMonitor({ interval = 1000 } = {}) {
    let timeoutsUsed = 0;
    let armed = true; // true = morale is currently below threshold, ready to fire again
    let bannerActive = false; // true while the CURRENT banner sighting has already been countered
    let lastMoraleLog = 0;
    let busy = false;
    let running = true;

    const timer = setInterval(async () => {
      if (!running || busy) return;

      // 1. Scan center balloon for enemy props.
      // Edge-triggered, not time-throttled: we only counter on the
      // transition from "no banner" -> "banner visible" (bannerActive flips
      // false -> true). Once the banner disappears again (activeProp goes
      // back to null), bannerActive re-arms — so the very next time the
      // SAME prop (or any prop) is used, even a second later, it's detected
      // and countered again.
      const activeProp = readActivePropBanner();
      if (activeProp) {
        if (!bannerActive) {
          bannerActive = true;
          busy = true;
          try {
            await counterEnemyProp(activeProp);
          } catch (e) {
            console.warn('  ⚠️ Prop counter error:', e.message);
          }
          busy = false;
        }
      } else {
        bannerActive = false; // banner is gone — ready to fire again next time
      }

      // 2. Timeout check on high opponent morale — up to MAX_TIMEOUTS_PER_MATCH
      // cycles per match. "armed" gives it a rising-edge trigger.
      if (timeoutsUsed >= MAX_TIMEOUTS_PER_MATCH) return;

      const morale = readOpponentMorale();
      if (morale === null) return;

      if (Date.now() - lastMoraleLog > 3000) {
        lastMoraleLog = Date.now();
        console.log(`  📊 Opponent morale reading: ${morale} (threshold ${MORALE_THRESHOLD}, timeouts used ${timeoutsUsed}/${MAX_TIMEOUTS_PER_MATCH})`);
      }

      if (!armed) {
        if (morale < MORALE_THRESHOLD) armed = true; // re-arm once it dips back down
        return;
      }

      if (morale >= MORALE_THRESHOLD) {
        busy = true;
        console.log(`  📞 Morale ${morale} ≥ ${MORALE_THRESHOLD} — calling timeout (${timeoutsUsed + 1}/${MAX_TIMEOUTS_PER_MATCH})`);
        try {
          const status = await callTimeout();
          if (status === 'clicked') {
            timeoutsUsed++;
            armed = false;
          } else if (status === 'no-charges') {
            timeoutsUsed = MAX_TIMEOUTS_PER_MATCH;
          }
        } catch (e) {
          console.warn('  ⚠️ Timeout attempt failed:', e.message);
        }
        busy = false;
      }
    }, interval);

    return {
      stop() { running = false; clearInterval(timer); },
      get timeoutsUsed() { return timeoutsUsed; }
    };
  }

  // ==================== BOTTOM DOCK / MATCH HALL ====================

  /**
   * Finds a button in the bottom navigation dock (TASKS, BAG, ... MATCH,
   * COURT, OFFICE) by its exact label.
   *
   * Constrained to the bottom quarter of the viewport on purpose: a plain
   * search for "MATCH" also hits "MATCH HALL", "MATCH IN PROGRESS" and
   * "RESUME MATCH" inside the overlay, and clicking any of those does
   * something quite different.
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
      if (r.top < vh * 0.75) continue;          // dock sits along the bottom
      hits.push({ el, area: r.width * r.height });
    }

    if (!hits.length) return null;

    // Smallest match is the text label itself; the clickable tile is its
    // ancestor, so climb to that.
    const label_el = hits.reduce((a, b) => (a.area <= b.area ? a : b)).el;
    return label_el.closest(CLICKABLE) || label_el.parentElement || label_el;
  }

  /** True when the Match Hall overlay is on screen. */
  function isMatchHallOpen() {
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = directText(el).toUpperCase().replace(/\s+/g, ' ').trim();
      if (t === 'MATCH HALL') return true;
    }
    // Fallback: the SCRIMMAGE tab (shared tab bar with SEASON/RANKED) only
    // exists inside the hall.
    return findTab('SCRIMMAGE') !== null;
  }

  /**
   * Opens the Match Hall by clicking MATCH in the bottom dock. Preferred over
   * navigating: a page reload throws away the session's in-memory state and
   * costs several seconds.
   */
  async function openMatchHall({ timeout = 15000 } = {}) {
    if (isMatchHallOpen()) {
      console.log('  🏟️ Match Hall already open.');
      return true;
    }

    const btn = findDockButton('MATCH');
    if (!btn) {
      console.warn('  ⚠️ MATCH button not found in the bottom dock.');
      bridge.send('error', {
        text: 'Could not find the MATCH button. Make sure you are signed in and on the main screen.',
        source: 'ranked'
      });
      return false;
    }

    triggerClick(btn);
    console.log('  🖱️ Clicked MATCH in the bottom dock.');

    try {
      await waitFor(() => isMatchHallOpen() || null,
        { timeout, stableFor: 300, interval: 200, label: 'Match Hall to open' });
      console.log('  🏟️ Match Hall open.');
      return true;
    } catch (err) {
      console.warn('  ⚠️ Match Hall did not open: ' + err.message);
      bridge.send('error', { text: 'The Match Hall did not open in time.', source: 'ranked' });
      return false;
    }
  }

  // ==================== SHARED PHASES ====================

  async function resumeIfMatchInProgress() {
    const resume = findByLabel('RESUME MATCH') || findByLabel('REJOIN');
    if (!resume) return false;
    triggerClick(resume);
    await sleep(1500);
    return true;
  }

  function findFindRankedMatchButton() {
    const strict = findByLabel('FIND RANKED MATCH');
    if (strict) return strict;

    return [...document.querySelectorAll(CLICKABLE)].find(el => {
      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      return text.includes('FIND RANKED MATCH') && isVisible(el);
    }) || null;
  }

  async function clickFindRankedMatchButton({ timeout = 5 * 60 * 1000, stableFor = 600 } = {}) {
    const findMatchBtn = await waitFor(
      () => findFindRankedMatchButton(),
      { timeout, stableFor, label: 'FIND RANKED MATCH button' }
    );
    triggerClick(findMatchBtn);
    return findMatchBtn;
  }

  async function waitForRankedLobby({ timeout = 60 * 1000 } = {}) {
    // A CONTINUE click — whether triggered by this script or pressed
    // manually — can drop back onto a different tab (Match Hall defaults
    // to SCRIMMAGE). This keeps nudging back to RANKED every few seconds
    // instead of trying once, in case it lands mid page-transition.
    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeout) {
      attempt++;
      await switchToTab('RANKED');
      try {
        return await waitFor(
          () => (!findByLabel('CONTINUE') && findFindRankedMatchButton()) || null,
          { timeout: 3000, stableFor: 400, label: 'Ranked lobby to reload' }
        );
      } catch {
        console.warn(`  ⚠️ Not back on Ranked lobby yet (attempt ${attempt}) — retrying`);
      }
    }
    throw new Error('Timed out waiting for Ranked lobby to reload');
  }

  async function clickContinueWhenMatchEnds({ timeout = 6 * 60 * 1000, stableFor = 500 } = {}) {
    const continueBtn = await waitFor(
      () => findByLabel('CONTINUE'),
      { timeout, stableFor, label: 'CONTINUE (match summary)' }
    );

    const result = readMatchResult();
    if (result) console.log(result === 'VICTORY' ? '  🏆 VICTORY' : '  💀 DEFEAT');

    triggerClick(continueBtn);
    return result;
  }

  // ==================== PHASE 1: SEASON ====================

  async function runSeasonPhase() {
    console.log('\n── PHASE 1: SEASON ──');
    let played = 0, wins = 0, losses = 0;

    for (let i = 1; i <= MAX_SEASON_GAMES; i++) {
      if (stopped) break;

      if (!(await switchToTab('SEASON'))) {
        console.warn('  ⚠️ Skipping season phase — tab unavailable');
        break;
      }

      const left = readDailyGamesLeft();
      if (left !== null) console.log(`  📅 Daily games left today: ${left}`);

      let playBtn;
      try {
        playBtn = await waitFor(() => findPlayGameButton(), { timeout: 5000, label: 'Season PLAY GAME button' });
      } catch {
        console.log('  ℹ️ No PLAY GAME button found — season games done');
        break;
      }

      if (!isEnabled(playBtn)) {
        console.log('  🔒 PLAY GAME button is disabled — daily limit reached');
        break;
      }

      const label = (playBtn.textContent || '').trim().replace(/\s+/g, ' ');
      console.log(`\n  ▶️ Season game ${i}/${MAX_SEASON_GAMES} — "${label}"`);

      let monitor = null, result = null;
      try {
        triggerClick(playBtn);
        await sleep(1500);
        monitor = startInMatchMonitor();
        result = await clickContinueWhenMatchEnds();
        console.log('  ✅ CONTINUE clicked — exiting summary');
        if (result === 'VICTORY') wins++;
        else if (result === 'DEFEAT') losses++;
        played++;
      } catch (err) {
        console.error(`  ❌ Season game ${i} failed: ${err.message}`);
        const stray = findByLabel('CONTINUE');
        if (stray) {
          triggerClick(stray);
          await sleep(1500);
        }
        break;
      } finally {
        if (monitor) monitor.stop();
      }

      if (result === 'DEFEAT') {
        console.log(`  ⏳ Defeat — waiting ${DEFEAT_DELAY / 1000}s`);
        await sleep(DEFEAT_DELAY);
      }
      await sleep(2500);
    }
    console.log(`\n  📊 Season phase done — ${played} played (${wins}W-${losses}L)`);
    return { played, wins, losses };
  }

  // ==================== PHASE 2: RANKED ====================

  async function runRankedPhase({ matchLimit = 1000, restBetween = 1200, onProgress = null } = {}) {
    console.log('\n── PHASE 2: RANKED ──');
    await switchToTab('RANKED');

    let completed = 0, failed = 0, wins = 0, losses = 0;
    await resumeIfMatchInProgress();

    for (let i = 1; i <= matchLimit; i++) {
      if (stopped) break;

      const counter = readRewardsCounter();
      console.log(counter
        ? `\n▶️ Match ${i}/${matchLimit} | Rewards: ${counter.current}/${counter.total}`
        : `\n▶️ Match ${i}/${matchLimit}`);

      let monitor = null, result = null;
      try {
        await clickFindRankedMatchButton();
        console.log('  ✅ FIND RANKED MATCH clicked — searching for opponent');
        monitor = startInMatchMonitor();
        result = await clickContinueWhenMatchEnds();
        console.log('  ✅ CONTINUE clicked — exiting summary');
        if (result === 'VICTORY') wins++;
        else if (result === 'DEFEAT') losses++;
        completed++;
      } catch (err) {
        failed++;
        console.error(`  ❌ Match ${i} failed: ${err.message}`);
        const stray = findByLabel('CONTINUE');
        if (stray) {
          triggerClick(stray);
          await sleep(1500);
        } else {
          await resumeIfMatchInProgress();
        }
      } finally {
        if (monitor) monitor.stop();
      }

      if (typeof onProgress === 'function') {
        onProgress({ current: i, total: matchLimit, completed, failed, wins, losses, lastResult: result });
      }

      if (result === 'DEFEAT') {
        console.log(`  ⏳ Defeat — waiting ${DEFEAT_DELAY / 1000}s`);
        await sleep(DEFEAT_DELAY);
      }
      try {
        await waitForRankedLobby();
      } catch {}
      if (result !== 'DEFEAT') await sleep(restBetween);
    }
    return { completed, failed, wins, losses };
  }

  // ==================== ORCHESTRATOR ====================

  let stopped = false;

  /**
   * Host entry point. `config` mirrors RunConfig from the WPF host:
   *   { targetIterations, actionDelayMs }
   * targetIterations becomes the Ranked-phase match cap; actionDelayMs
   * becomes the rest between Ranked matches. The Season phase (up to
   * MAX_SEASON_GAMES) always runs first and is not itself configurable —
   * it is a fixed daily cap the game enforces regardless of these settings.
   */
  async function runAll(config = {}) {
    stopped = false;

    const matchLimit = Number.isFinite(config.targetIterations) && config.targetIterations > 0
      ? config.targetIterations
      : 1000;
    const restBetween = Number.isFinite(config.actionDelayMs) && config.actionDelayMs >= 0
      ? config.actionDelayMs
      : 1200;

    console.log('🚀 Starting Ranked automation — open Match Hall, then Season check, then Ranked loop');
    bridge.send('started', { total: matchLimit });
    bridge.status('Opening the Match Hall...');

    const hallOpen = await openMatchHall();
    if (!hallOpen) {
      bridge.send('done', { current: 0, total: matchLimit, succeeded: 0, failed: 0, cancelled: true });
      return { season: null, ranked: null };
    }

    const season = await runSeasonPhase();
    if (stopped) {
      bridge.send('done', {
        current: 0, total: matchLimit, succeeded: season.wins, failed: season.losses, cancelled: true
      });
      return { season };
    }

    const ranked = await runRankedPhase({
      matchLimit,
      restBetween,
      onProgress: (p) => bridge.send('progress', {
        current: p.current, total: p.total,
        text: p.lastResult || (p.failed ? 'failed' : undefined)
      })
    });

    const totalWins = season.wins + ranked.wins;
    const totalLosses = season.losses + ranked.losses;
    const played = totalWins + totalLosses;
    const winrate = played > 0 ? ((totalWins / played) * 100).toFixed(1) : '0.0';
    const final = readRewardsCounter();

    console.log('\n── SESSION COMPLETE ──');
    console.log(`📅 Season: ${season.played} played (${season.wins}W-${season.losses}L)`);
    console.log(`🏆 Ranked: ${ranked.completed} completed, ${ranked.failed} failed`);
    console.log(`📊 Overall: ${totalWins}W - ${totalLosses}L | Winrate: ${winrate}%`);
    if (final) console.log(`🎁 Final rewards: ${final.current}/${final.total}`);

    bridge.send('done', {
      current: ranked.completed, total: matchLimit,
      succeeded: totalWins, failed: totalLosses + ranked.failed, cancelled: stopped
    });

    return { season, ranked };
  }

  // Global console bindings — kept for manual DevTools debugging.
  window.readRewardsCounter = readRewardsCounter;
  window.readDailyGamesLeft = readDailyGamesLeft;
  window.findPlayGameButton = findPlayGameButton;
  window.readActivePropBanner = readActivePropBanner;
  window.findCloseButton = findCloseButton;
  window.closePropMenu = closePropMenu;
  window.readOpponentMorale = readOpponentMorale;
  window.findTimeoutButton = findTimeoutButton;
  window.findFindRankedMatchButton = findFindRankedMatchButton;
  window.deepText = deepText;
  window.readMatchResult = readMatchResult;
  window.callTimeout = callTimeout;
  window.runSeasonPhase = runSeasonPhase;
  window.runRankedPhase = runRankedPhase;

  // Host-facing entry points — same shape as automation.js's
  // startLoop/stopLoop, so MainWindow.xaml.cs can drive either script
  // through the same Start/Stop plumbing.
  window.startRankedLoop = function (config) {
    // Not awaited: ExecuteScriptAsync must return immediately so the host
    // isn't blocked for the whole session — the host is driven entirely by
    // postMessage (started/progress/done) from here on, same contract as
    // automation.js's startLoop. The .catch is a safety net: if something
    // throws before runAll's own 'done' send, the host still gets one and
    // the Start button doesn't stay stuck disabled forever.
    runAll(config).catch((err) => {
      console.error('[ranked] fatal:', err && err.message);
      bridge.send('done', { current: 0, total: 0, succeeded: 0, failed: 0, cancelled: true });
    });
    return 'started';
  };
  window.stopLoop = () => { stopped = true; };
})();
