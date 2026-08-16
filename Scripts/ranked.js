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

    // 2. Loose match, still restricted to real <button>/<a>/role="button" elements.
    btn = [...document.querySelectorAll(CLICKABLE)].find(el => {
      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      return (
        (text.includes('PLAY GAME') || /^PLAY\s*GAME/.test(text)) &&
        isVisible(el) &&
        isEnabled(el)
      );
    });
    if (btn) return btn;

    // 3. Playoffs bracket screen: its "PLAY GAME N" CTA is frequently a
    // styled <div>/<span> rather than a real button/link, so CLICKABLE never
    // matches it — and the game number is often its own nested badge/span,
    // so no single element's OWN direct text reads "PLAY GAME N" either.
    // Aggregated .textContent (same as tiers 1-2, just without the CLICKABLE
    // restriction) is what actually captures it regardless of how the label
    // is split internally. Wrapped in try/catch: the bracket screen can still
    // be mid-transition when this runs, and a node going stale between the
    // querySelectorAll and the getBoundingClientRect calls below would
    // otherwise throw and surface only as an opaque "Script error".
    try {
      const candidates = [...document.querySelectorAll('body *')].filter(el => {
        const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
        return /^PLAY GAME\s*\d+/.test(text) && isVisible(el);
      });
      if (!candidates.length) return null;

      // Smallest matching element is where the split text converges — the
      // label itself, not an outer wrapper.
      const smallest = candidates.reduce((best, el) => {
        const a = el.getBoundingClientRect();
        const b = best.getBoundingClientRect();
        return (a.width * a.height) < (b.width * b.height) ? el : best;
      });

      // Return the actual control, not the label: isEnabled() is about to be
      // called on whatever this returns, and label spans are frequently
      // styled pointer-events:none (so clicks always land on the outer
      // button, not gaps between letters) — checking THAT would make a
      // perfectly clickable button read as disabled. Prefer a real
      // CLICKABLE ancestor; failing that, climb until pointer-events stops
      // being 'none'.
      const clickableAncestor = smallest.closest(CLICKABLE);
      if (clickableAncestor) return clickableAncestor;

      let control = smallest;
      for (let node = smallest, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
        if (getComputedStyle(node).pointerEvents !== 'none') { control = node; break; }
      }
      return control;
    } catch (err) {
      console.warn('  ⚠️ PLAY GAME wide-scan failed: ' + err.message);
      return null;
    }
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

  // ==================== SCOREBOARD READERS ====================
  // Ported from automation.js — the post-match summary screen (score, MVP
  // card, opponent handle) is the same UI regardless of which mode queued
  // the match, so the same heuristics apply here for Ranked/Season games.
  // Both return null rather than guessing, so a bad read shows as 0 in the
  // grid instead of silently inventing a plausible-looking score.

  /** Set false if your score renders on the RIGHT of the opponent's. */
  const PLAYER_SCORE_ON_LEFT = true;

  /** Collects every visible element whose own text is a bare score-like number. */
  function collectScoreNumbers({ maxTop = 1.0 } = {}) {
    const vh = window.innerHeight;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = directText(el).trim();
      if (!/^\d{1,3}$/.test(t)) continue;
      const n = Number(t);
      if (n > 250) continue;                       // scores, not clocks or ids
      const r = el.getBoundingClientRect();
      if (r.top > vh * maxTop) continue;
      out.push({
        n,
        el,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
        fontSize: parseFloat(getComputedStyle(el).fontSize) || 0,
        area: r.width * r.height
      });
    }
    return out;
  }

  function pairByPosition(nums, source) {
    if (nums.length < 2) return null;
    const sorted = [...nums].sort((a, b) => a.cx - b.cx);
    const left = sorted[0].n;
    const right = sorted[sorted.length - 1].n;
    return PLAYER_SCORE_ON_LEFT
      ? { mine: left, theirs: right, source }
      : { mine: right, theirs: left, source };
  }

  /**
   * Final score, tried three ways in descending order of confidence:
   *   1. a single element reading "110 - 125"
   *   2. the two numbers nearest the VICTORY/DEFEAT banner
   *   3. the two largest-font numbers on the upper half of the screen
   */
  function readFinalScore() {
    const PATTERN = /\b(\d{1,3})\s*[-–—:/]\s*(\d{1,3})\b/;
    const hits = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const own = directText(el);
      if (!own) continue;
      const m = own.match(PATTERN);
      if (!m) continue;
      const a = Number(m[1]), b = Number(m[2]);
      if (a > 250 || b > 250) continue;
      const rect = el.getBoundingClientRect();
      hits.push({ mine: a, theirs: b, area: rect.width * rect.height, source: 'inline' });
    }
    if (hits.length) {
      return hits.reduce((best, h) => (h.area < best.area ? h : best));
    }

    const banner = [...document.querySelectorAll('body *')].find(el => {
      if (!isVisible(el)) return false;
      const own = directText(el).toUpperCase().replace(/[^A-Z]/g, '');
      return own === 'VICTORY' || own === 'DEFEAT';
    });

    if (banner) {
      let node = banner.parentElement;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const local = collectScoreNumbers().filter(c => node.contains(c.el));
        if (local.length >= 2) {
          const paired = pairByPosition(local, `banner+${depth}`);
          if (paired) return paired;
        }
      }
    }

    const upper = collectScoreNumbers({ maxTop: 0.6 });
    if (upper.length >= 2) {
      const maxFont = Math.max(...upper.map(c => c.fontSize));
      const big = upper.filter(c => c.fontSize >= maxFont * 0.85);
      const paired = pairByPosition(big.length >= 2 ? big : upper, 'largest-font');
      if (paired) return paired;
    }

    return null;
  }

  // ==================== MVP CARD ====================
  // The post-match panel looks like:
  //     MVP · PF
  //     TIM DUNCAN          <- the player who earned it
  //     [MNR] S1MPLE        <- the handle of whoever owns that player
  //     36 PTS  17 REB  7 AST
  //
  // Either side can earn MVP, so the handle is NOT reliably the opponent —
  // which is why these are recorded as two distinct fields.

  const TAG_PATTERN = /\[[^\]]{1,12}\]/;
  const STAT_LABELS = new Set(['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'MIN', 'FG', '3PT', 'FT', 'PF']);

  /**
   * Some names render one letter per element, which reads back as
   * "W E W E N G". If every token is a single character, glue them together.
   */
  function collapseLetterSpacing(s) {
    const parts = String(s || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 3 && parts.every(p => p.length === 1)) return parts.join('');
    return parts.join(' ');
  }

  /** Normalises "[MNR]  S 1 M P L E" -> "[MNR] S1MPLE". */
  function tidyHandle(raw) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    const m = text.match(/^(\[[^\]]{1,12}\])\s*(.*)$/);
    if (!m) return collapseLetterSpacing(text);
    const name = collapseLetterSpacing(m[2]);
    return name ? `${m[1]} ${name}` : m[1];
  }

  function tidyName(raw) {
    return collapseLetterSpacing(String(raw || '').replace(/\s+/g, ' ').trim());
  }

  /** Returns { mvpName, mvpHandle } from the post-match MVP panel. */
  function readMvpCard() {
    const badge = [...document.querySelectorAll('body *')].find(el => {
      if (!isVisible(el)) return false;
      const t = directText(el).toUpperCase().replace(/\s+/g, ' ').trim();
      return /^MVP\b/.test(t) && t.length <= 24;
    });

    let container = null;
    if (badge) {
      let node = badge.parentElement;
      for (let d = 0; node && d < 6; d++, node = node.parentElement) {
        if (TAG_PATTERN.test(node.textContent || '')) { container = node; break; }
      }
      if (!container) container = badge.parentElement;
    }

    if (!container) {
      const handleEl = [...document.querySelectorAll('body *')].find(el =>
        isVisible(el) && TAG_PATTERN.test(directText(el)) && directText(el).trim().length <= 48);
      if (!handleEl) return null;
      container = handleEl.parentElement || handleEl;
    }

    let mvpHandle = null;
    let bestArea = Infinity;
    for (const el of [container, ...container.querySelectorAll('*')]) {
      if (!isVisible(el)) continue;
      const t = directText(el).trim();
      if (!t || t.length > 48 || !TAG_PATTERN.test(t)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < bestArea) { bestArea = area; mvpHandle = t; }
    }

    const candidates = [];
    for (const el of container.querySelectorAll('*')) {
      if (!isVisible(el)) continue;
      const t = directText(el).trim();
      if (!t || t.length < 2 || t.length > 32) continue;
      const up = t.toUpperCase().replace(/\s+/g, ' ');
      if (TAG_PATTERN.test(t)) continue;
      if (/^MVP\b/.test(up)) continue;
      if (STAT_LABELS.has(up)) continue;
      if (/^[\d\s.·•|-]+$/.test(t)) continue;
      if (!/[A-Za-z]/.test(t)) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      candidates.push({ t, fs });
    }
    candidates.sort((a, b) => b.fs - a.fs);

    return {
      mvpName: candidates.length ? tidyName(candidates[0].t) : null,
      mvpHandle: mvpHandle ? tidyHandle(mvpHandle) : null
    };
  }

  /**
   * Opponent handle — scans the whole document for a clan-tagged handle
   * like "[MNR] S1MPLE" and takes the RIGHTMOST one, since the opponent
   * occupies the right side of the scoreboard. Deliberately NOT scoped to
   * the MVP card: that shows whoever earned MVP, which is often your own
   * player.
   */
  function readOpponentName() {
    const TAGGED = /\[[^\]]{1,12}\]\s*\S+/;

    const tagged = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const own = directText(el).trim();
      if (!own || own.length > 48) continue;
      if (!TAGGED.test(own.toUpperCase())) continue;
      const rect = el.getBoundingClientRect();
      tagged.push({
        name: tidyHandle(own),
        centerX: rect.left + rect.width / 2
      });
    }

    if (!tagged.length) return null;
    tagged.sort((a, b) => b.centerX - a.centerX);
    return tagged[0].name;
  }

  /**
   * Sends one structured match record to the WPF host, which prepends it to
   * the Match History grid. Everything is coerced here rather than in C#:
   * postMessage will happily ship a NaN or an undefined.
   */
  function sendMatchSummaryToHost(outcome, myScore, opponentScore, mvpName, opponentName) {
    const payload = {
      outcome: String(outcome || 'UNKNOWN').toUpperCase(),
      myScore: Number.isFinite(Number(myScore)) ? Number(myScore) : 0,
      opponentScore: Number.isFinite(Number(opponentScore)) ? Number(opponentScore) : 0,
      mvpName: String(mvpName || '—').trim(),
      opponentName: String(opponentName || '—').trim()
    };
    bridge.send('MATCH_SUMMARY', payload);
    return payload;
  }

  /**
   * Assembles and dispatches the record for a finished match. Reads the
   * scoreboard BEFORE the caller clicks CONTINUE — the summary screen is the
   * only place these values exist, and the click tears it down.
   */
  function reportMatchSummary(result) {
    const score = readFinalScore();
    const card = readMvpCard();
    const opponent = readOpponentName();

    if (!score) console.warn('  ⚠️ Could not read final score — recording 0-0');
    if (!card || !card.mvpName) console.warn('  ⚠️ Could not read MVP player name');
    if (!opponent) console.warn('  ⚠️ Could not read opponent name');

    return sendMatchSummaryToHost(
      result || 'UNKNOWN',
      score ? score.mine : 0,
      score ? score.theirs : 0,
      card ? card.mvpName : null,
      opponent
    );
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
   * Generic map-overlay button, e.g. the "STADIUM" label floating over its
   * building on the City map. Unlike findDockButton, NOT constrained to the
   * bottom-dock region — these labels sit wherever their building is drawn,
   * which varies with the map layout.
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
    const label_el = hits.reduce((a, b) => (a.area <= b.area ? a : b)).el;
    return label_el.closest(CLICKABLE) || label_el.parentElement || label_el;
  }

  /**
   * Opens the Match Hall. Interface update: the bottom dock's MATCH button
   * was replaced by a CITY button that opens a city-map overlay; reaching
   * the Match Hall now means clicking CITY, then the STADIUM building on
   * that map. Preferred over navigating: a page reload throws away the
   * session's in-memory state and costs several seconds.
   */
  async function openMatchHall({ timeout = 15000 } = {}) {
    if (isMatchHallOpen()) {
      console.log('  🏟️ Match Hall already open.');
      return true;
    }

    const cityBtn = findDockButton('CITY');
    if (!cityBtn) {
      console.warn('  ⚠️ CITY button not found in the bottom dock.');
      bridge.send('error', {
        text: 'Could not find the CITY button. Make sure you are signed in and on the main screen.',
        source: 'ranked'
      });
      return false;
    }

    triggerClick(cityBtn);
    console.log('  🖱️ Clicked CITY in the bottom dock.');

    let stadiumBtn;
    try {
      stadiumBtn = await waitFor(() => findMapLabel('STADIUM'),
        { timeout, stableFor: 300, interval: 200, label: 'STADIUM building' });
    } catch (err) {
      console.warn('  ⚠️ STADIUM building did not appear: ' + err.message);
      bridge.send('error', { text: 'The city map did not show a STADIUM building in time.', source: 'ranked' });
      return false;
    }

    triggerClick(stadiumBtn);
    console.log('  🖱️ Clicked STADIUM.');

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

    // Read the scoreboard BEFORE clicking CONTINUE — the summary screen is
    // the only place these values exist, and the click tears it down.
    const record = reportMatchSummary(result);
    console.log(`  📋 Recorded: ${record.outcome} ${record.myScore}-${record.opponentScore} vs ${record.opponentName} | MVP ${record.mvpName}`);

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

      // The Playoffs bracket view in particular can take a beat to finish
      // rendering after the tab switch — its PLAY GAME button isn't always
      // there yet the instant the tab click resolves. waitFor() below still
      // polls for up to 8s regardless, but giving it a head start here
      // avoids racing a bracket screen that's still mid-transition.
      await sleep(1500);

      const left = readDailyGamesLeft();
      if (left !== null) console.log(`  📅 Daily games left today: ${left}`);

      let playBtn;
      try {
        playBtn = await waitFor(() => findPlayGameButton(), { timeout: 8000, label: 'Season PLAY GAME button' });
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
