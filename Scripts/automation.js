/* =====================================================================
 * Hoops Arena automation — harness edition.
 *
 * All game logic is unchanged. What was added:
 *   - install guard, so re-injecting on Start never stacks two loops
 *   - window.startLoop(config) / window.stopLoop() / window.loopStatus()
 *   - progress + done messages so the WPF host can unlock its UI
 *   - CANCELLABLE sleep() and waitFor(), so Stop aborts an in-flight wait
 *     instead of blocking for up to the full 6-minute timeout
 * ===================================================================== */
(function () {
  'use strict';

  if (window.__automationInstalled) {
    console.info('[automation] bundle already installed — reusing.');
    return;
  }
  window.__automationInstalled = true;

  // ==================== HOST TRANSPORT ====================

  function post(msg) {
    if (window.__wpf && typeof window.__wpf.post === 'function') window.__wpf.post(msg);
    else if (window.chrome && window.chrome.webview) {
      try { window.chrome.webview.postMessage(msg); } catch (_) { }
    }
  }

  // ==================== TUNABLES ====================

  const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';
  const MORALE_THRESHOLD = 45;
  const MAX_TIMEOUTS_PER_MATCH = 2;
  const DEFEAT_DELAY = 10000;
  const MAX_SEASON_GAMES = 3;

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

  // ==================== CANCELLATION CORE ====================

  let stopped = false;
  let running = false;
  let config = {};
  let matchesDone = 0;
  let plannedTotal = 0;
  let activeMonitor = null;

  /** Thrown to unwind the stack cleanly when the operator hits Stop. */
  class StopSignal extends Error {
    constructor() { super('stopped'); this.name = 'StopSignal'; }
  }
  const isStop = e => e instanceof StopSignal || (e && e.name === 'StopSignal');

  /** Every in-flight timer/waiter registers here so stopLoop can abort it. */
  const cancellers = new Set();

  function abortAllWaits() {
    for (const cancel of [...cancellers]) {
      try { cancel(); } catch (_) { }
    }
    cancellers.clear();
  }

  function throwIfStopped() { if (stopped) throw new StopSignal(); }

  /** sleep that rejects immediately when Stop is pressed. */
  function sleep(ms) {
    return new Promise((resolve, reject) => {
      if (stopped) { reject(new StopSignal()); return; }
      const cancel = () => { clearTimeout(timer); cancellers.delete(cancel); reject(new StopSignal()); };
      const timer = setTimeout(() => { cancellers.delete(cancel); resolve(); }, ms);
      cancellers.add(cancel);
    });
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

  function joinPresent() {
    return findByLabel('JOIN') !== null;
  }

  // ==================== REWARDS COUNTER ====================

  /**
   * Reads the "52 / 100" rewards counter.
   *
   * Deliberately NOT pinned to a fixed total. The previous version hardcoded
   * the cap and silently returned null whenever the game used a different one,
   * which made the loop fall back to its "run forever" count. Instead: accept
   * any sane N/M, and prefer whichever one sits inside something mentioning
   * REWARD.
   */
  function readRewardsCounter() {
    const PATTERN = /\b(\d{1,4})\s*\/\s*(\d{1,4})\b/;
    const candidates = [];

    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const own = directText(el);
      if (!own) continue;
      const m = own.match(PATTERN);
      if (!m) continue;

      const current = Number(m[1]);
      const total = Number(m[2]);
      if (total < 5 || total > 100000) continue;   // not a scoreline or a clock
      if (current > total) continue;

      // Does anything within a few ancestors call this a reward?
      let labelled = false;
      let node = el;
      for (let d = 0; node && d < 4; d++, node = node.parentElement) {
        if ((node.textContent || '').toUpperCase().includes('REWARD')) { labelled = true; break; }
      }

      const r = el.getBoundingClientRect();
      candidates.push({
        current, total,
        remaining: Math.max(0, total - current),
        labelled,
        area: r.width * r.height
      });
    }

    if (!candidates.length) return null;

    const labelledOnes = candidates.filter(c => c.labelled);
    const pool = labelledOnes.length ? labelledOnes : candidates;

    // Smallest element is the counter itself, not a wrapper containing it.
    return pool.reduce((best, c) => (c.area < best.area ? c : best));
  }

  // ==================== SEASON HELPERS ====================

  function findPlayGameButton() {
    // 1. Original strict match: "PLAY GAME" + number (e.g. "PLAY GAME 1")
    let btn = [...document.querySelectorAll(CLICKABLE)].find(el => {
      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      return /^PLAY GAME\s*\d+/.test(text) && isVisible(el);
    });
    if (btn) return btn;

    // 2. Fallback for the Season playoffs button
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

  // ==================== HOST DATA BRIDGE ====================

  /**
   * Sends one structured match record to the WPF host, which prepends it to
   * the Match History grid. This is the payload the C# side expects:
   *
   *   { type: "MATCH_SUMMARY", outcome: "DEFEAT",
   *     myScore: 110, opponentScore: 125, opponentName: "[MNR] S1MPLE" }
   *
   * Everything is coerced here rather than in C#: postMessage will happily
   * ship a NaN or an undefined, and those deserialize to junk on the host.
   */
  function sendMatchSummaryToHost(outcome, myScore, opponentScore, mvpName, opponentName) {
    const payload = {
      type: 'MATCH_SUMMARY',
      outcome: String(outcome || 'UNKNOWN').toUpperCase(),
      myScore: Number.isFinite(Number(myScore)) ? Number(myScore) : 0,
      opponentScore: Number.isFinite(Number(opponentScore)) ? Number(opponentScore) : 0,
      mvpName: String(mvpName || '—').trim(),
      opponentName: String(opponentName || '—').trim()
    };
    post(payload);
    return payload;
  }

  /** Plain log line addressed at the Console Log tab. */
  function sendLogToHost(text, level) {
    post({ type: 'LOG', level: level || 'info', text: String(text), source: 'automation' });
  }

  // ==================== SCOREBOARD READERS ====================
  // Heuristics — tune the selectors here once you know the real markup.
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
   * Returns null if none of them produce a sane pair, so a bad read shows
   * as 0-0 rather than an invented score.
   */
  function readFinalScore() {
    // ---- strategy 1: combined scoreline in one element ----------------
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

    // ---- strategy 2: numbers sharing a container with the banner ------
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

    // ---- strategy 3: biggest numbers on the scoreboard ----------------
    const upper = collectScoreNumbers({ maxTop: 0.6 });
    if (upper.length >= 2) {
      const maxFont = Math.max(...upper.map(c => c.fontSize));
      const big = upper.filter(c => c.fontSize >= maxFont * 0.85);
      const paired = pairByPosition(big.length >= 2 ? big : upper, 'largest-font');
      if (paired) return paired;
    }

    return null;
  }

  /**
   * Diagnostic. Run from DevTools (F12) on a match summary screen and paste
   * the table — it shows every number the readers can see, with position and
   * font size, which is what a precise selector gets written from.
   */
  function dumpScoreCandidates() {
    const rows = collectScoreNumbers().map(c => ({
      value: c.n,
      x: Math.round(c.cx),
      y: Math.round(c.cy),
      fontSize: c.fontSize,
      tag: c.el.tagName.toLowerCase(),
      cls: (c.el.className || '').toString().slice(0, 40),
      parentText: (c.el.parentElement?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
    }));
    console.table(rows);
    console.log('readFinalScore()   =>', readFinalScore());
    console.log('readMvpCard()      =>', readMvpCard());
    console.log('readOpponentName() =>', readOpponentName());
    return rows;
  }

  // ==================== MVP CARD ====================
  // The post-match panel looks like:
  //     MVP · PF
  //     TIM DUNCAN          <- the player who earned it
  //     [MNR] S1MPLE        <- the handle of whoever owns that player
  //     36 PTS  17 REB  7 AST
  //
  // Either side can earn MVP, so the handle is NOT reliably the opponent —
  // which is why these are recorded as two distinct fields rather than being
  // squashed into one "opponent" column.

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

  /**
   * Returns { mvpName, mvpHandle } from the post-match MVP panel.
   * Either field may be null if that part of the card could not be read.
   */
  function readMvpCard() {
    // 1. Find the "MVP" badge — short text starting with MVP, e.g. "MVP · PF".
    const badge = [...document.querySelectorAll('body *')].find(el => {
      if (!isVisible(el)) return false;
      const t = directText(el).toUpperCase().replace(/\s+/g, ' ').trim();
      return /^MVP\b/.test(t) && t.length <= 24;
    });

    // 2. Walk up until we reach an ancestor that also holds a tagged handle —
    //    that ancestor is the card, and scoping to it keeps unrelated handles
    //    elsewhere on the page out of the result.
    let container = null;
    if (badge) {
      let node = badge.parentElement;
      for (let d = 0; node && d < 6; d++, node = node.parentElement) {
        if (TAG_PATTERN.test(node.textContent || '')) { container = node; break; }
      }
      if (!container) container = badge.parentElement;
    }

    // 3. Fallback: no badge found, so use whichever tagged handle is on screen.
    if (!container) {
      const handleEl = [...document.querySelectorAll('body *')].find(el =>
        isVisible(el) && TAG_PATTERN.test(directText(el)) && directText(el).trim().length <= 48);
      if (!handleEl) return null;
      container = handleEl.parentElement || handleEl;
    }

    // 4. Handle: the smallest visible element inside the card carrying a tag.
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

    // 5. Player name: the largest-font text that is not the handle, the badge,
    //    a stat label, or a bare number.
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
   * Opponent handle — the original page-wide approach, restored.
   *
   * Scans the whole document for a clan-tagged handle like "[MNR] S1MPLE"
   * and takes the RIGHTMOST one, since the opponent occupies the right side
   * of the scoreboard. Deliberately NOT scoped to the MVP card: that card
   * shows whoever earned MVP, which is often your own player, so scoping to
   * it produced the wrong name.
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

  /** Assembles and dispatches the record for a finished match. */
  function reportMatchSummary(result) {
    const score = readFinalScore();
    const card = readMvpCard();          // MVP player only
    const opponent = readOpponentName(); // page-wide, rightmost tagged handle

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

  // ==================== GENERIC WAITER (cancellable) ====================

  function waitFor(condition, {
    timeout = 6 * 60 * 1000,
    interval = 500,
    stableFor = 0,
    label = 'condition'
  } = {}) {
    return new Promise((resolve, reject) => {
      if (stopped) { reject(new StopSignal()); return; }

      const start = Date.now();
      let heldSince = null;
      let settled = false;

      function finish(fn, arg) {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        observer.disconnect();
        cancellers.delete(cancel);
        fn(arg);
      }

      // Registered so Stop tears the waiter down immediately rather than
      // letting it sit for the remainder of its timeout.
      function cancel() { finish(reject, new StopSignal()); }

      function evaluate() {
        if (settled) return;
        if (stopped) { cancel(); return; }
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

      const timer = setInterval(evaluate, interval);
      const observer = new MutationObserver(evaluate);
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['class', 'style', 'disabled', 'hidden', 'aria-disabled']
      });
      cancellers.add(cancel);
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
   * active — and it applies the same way to any prop, tiered or not.
   */
  function bestPropMatch(text) {
    const exact = ENEMY_PROPS.find(p => text === p);
    if (exact) return exact;
    const subs = ENEMY_PROPS.filter(p => text.includes(p));
    if (!subs.length) return null;
    return subs.reduce((a, b) => (b.length > a.length ? b : a));
  }

  /** Scans for the central pop balloon announcing an opponent prop use. */
  function readActivePropBanner() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const matches = [];

    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;

      const text = (el.textContent || '').toUpperCase().replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const prop = bestPropMatch(text);
      if (!prop) continue;

      const rect = el.getBoundingClientRect();
      const inCenterY = rect.top > (vh * 0.25) && rect.bottom < (vh * 0.75);
      const inCenterX = rect.left > (vw * 0.25) && rect.right < (vw * 0.75);
      if (inCenterY && inCenterX) {
        matches.push({ prop, area: rect.width * rect.height });
      }
    }

    if (!matches.length) return null;
    return matches.reduce((best, m) => (m.area < best.area ? m : best)).prop;
  }

  /**
   * Finds a dedicated "close" control for an open modal/panel. Do NOT assume
   * the button that opened the panel (e.g. "PROP") also closes it on re-click.
   */
  function findCloseButton(root = document) {
    const ariaHit = [...root.querySelectorAll('[aria-label]')].find(el =>
      /close/i.test(el.getAttribute('aria-label') || '') && isVisible(el) && isEnabled(el)
    );
    if (ariaHit) return ariaHit;

    const glyphs = new Set(['×', '✕', '✖', 'X']);
    const glyphHit = [...root.querySelectorAll('body *')].find(el =>
      isVisible(el) && glyphs.has(ownText(el))
    );
    if (glyphHit) return glyphHit.closest(CLICKABLE) || glyphHit;

    return [...root.querySelectorAll('[class*="close" i]')].find(el => isVisible(el) && isEnabled(el)) || null;
  }

  async function closePropMenu(propBtn) {
    const closeBtn = findCloseButton();
    if (closeBtn) {
      triggerClick(closeBtn);
      console.log('  ✖️ Closed PROP menu via close button');
      await sleep(400);
      return true;
    }
    console.warn('  ⚠️ No dedicated close button found — falling back to re-clicking PROP');
    if (propBtn) triggerClick(propBtn);
    await sleep(400);
    return false;
  }

  /** Opens Control Deck -> selects matching prop -> confirms deployment. */
  async function counterEnemyProp(propName) {
    console.log(`  🚨 Center balloon detected: [${propName}] → Executing counter!`);

    const propBtn = findByLabel('PROP') || findByContains('PROP UTILITY') || findByContains('PROP');
    if (!propBtn) {
      console.warn('  ⚠️ PROP button not found in Control Deck');
      return false;
    }

    triggerClick(propBtn);
    console.log('  🎛️ Opened PROP menu');
    await sleep(500);

    const baseName = propName.replace(/\s*(I|II|III|IV|V|MAX|\d+)$/i, '').trim();

    function mostSpecificMatch(candidates) {
      if (!candidates.length) return null;
      const leaves = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
      const pool = leaves.length ? leaves : candidates;
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

          let candidates = items.filter(el => (el.textContent || '').toUpperCase().includes(propName));
          let match = mostSpecificMatch(candidates);

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
    } catch (e) {
      if (isStop(e)) throw e;
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

    console.warn('  ⚠️ No CONFIRM/USE/APPLY control appeared — prop was NOT deployed.');
    await closePropMenu(propBtn);
    return false;
  }

  // ==================== CONTROL DECK ACTIONS ====================

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
    return candidates.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

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
    let armed = true;
    let bannerActive = false;
    let lastMoraleLog = 0;
    let busy = false;
    let alive = true;

    const timer = setInterval(async () => {
      if (!alive || busy || stopped) return;

      const activeProp = readActivePropBanner();
      if (activeProp) {
        if (!bannerActive) {
          bannerActive = true;
          busy = true;
          try {
            await counterEnemyProp(activeProp);
          } catch (e) {
            if (!isStop(e)) console.warn('  ⚠️ Prop counter error:', e.message);
          }
          busy = false;
        }
      } else {
        bannerActive = false;
      }

      if (timeoutsUsed >= MAX_TIMEOUTS_PER_MATCH) return;

      const morale = readOpponentMorale();
      if (morale === null) return;

      if (Date.now() - lastMoraleLog > 3000) {
        lastMoraleLog = Date.now();
        console.log(`  🔍 Opponent morale reading: ${morale} (threshold ${MORALE_THRESHOLD}, timeouts used ${timeoutsUsed}/${MAX_TIMEOUTS_PER_MATCH})`);
      }

      if (!armed) {
        if (morale < MORALE_THRESHOLD) armed = true;
        return;
      }

      if (morale >= MORALE_THRESHOLD) {
        busy = true;
        console.log(`  📈 Morale ${morale} ≥ ${MORALE_THRESHOLD} → calling timeout (${timeoutsUsed + 1}/${MAX_TIMEOUTS_PER_MATCH})`);
        try {
          const status = await callTimeout();
          if (status === 'clicked') {
            timeoutsUsed++;
            armed = false;
          } else if (status === 'no-charges') {
            timeoutsUsed = MAX_TIMEOUTS_PER_MATCH;
          }
        } catch (e) {
          if (!isStop(e)) console.warn('  ⚠️ Timeout attempt failed:', e.message);
        }
        busy = false;
      }
    }, interval);

    const handle = {
      stop() { alive = false; clearInterval(timer); if (activeMonitor === handle) activeMonitor = null; },
      get timeoutsUsed() { return timeoutsUsed; }
    };
    activeMonitor = handle;
    return handle;
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
    // Fallback: the SCRIMMAGE tab only exists inside the hall.
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
      post({
        type: 'error',
        text: 'Could not find the MATCH button. Make sure you are signed in and on the main screen.',
        source: 'automation'
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
      if (isStop(err)) throw err;
      console.warn('  ⚠️ Match Hall did not open: ' + err.message);
      post({ type: 'error', text: 'The Match Hall did not open in time.', source: 'automation' });
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

  async function clickQuickPlayWhenJoinGone({ timeout = 5 * 60 * 1000, stableFor = 600 } = {}) {
    const quickPlay = await waitFor(
      () => (joinPresent() ? null : findByLabel('QUICK PLAY')),
      { timeout, stableFor, label: 'JOIN to clear and QUICK PLAY to appear' }
    );
    triggerClick(quickPlay);
    return quickPlay;
  }

  async function clickContinueWhenMatchEnds({ timeout = 6 * 60 * 1000, stableFor = 500 } = {}) {
    const continueBtn = await waitFor(
      () => findByLabel('CONTINUE'),
      { timeout, stableFor, label: 'CONTINUE (match summary)' }
    );

    const result = readMatchResult();
    if (result) console.log(result === 'VICTORY' ? '  🎉 VICTORY' : '  💀 DEFEAT');

    // Read the scoreboard BEFORE clicking CONTINUE — the summary screen is
    // the only place these values exist, and the click tears it down.
    const record = reportMatchSummary(result);
    console.log(`  📋 Recorded: ${record.outcome} ${record.myScore}-${record.opponentScore} vs ${record.opponentName} | MVP ${record.mvpName}`);

    triggerClick(continueBtn);
    return result;
  }

  function waitForLobby({ timeout = 60 * 1000 } = {}) {
    return waitFor(
      () => (!findByLabel('CONTINUE') && findByLabel('QUICK PLAY')) || null,
      { timeout, stableFor: 400, label: 'lobby to reload' }
    );
  }

  /** Reports one completed match to the host. */
  function reportMatch(note) {
    matchesDone++;
    post({
      type: 'progress',
      current: matchesDone,
      total: Math.max(plannedTotal, matchesDone),
      text: note || ''
    });
  }

  // ==================== PHASE 1: SEASON ====================

  async function runSeasonPhase() {
    console.log('\n═══ PHASE 1: SEASON ═══');
    let played = 0, wins = 0, losses = 0;

    for (let i = 1; i <= MAX_SEASON_GAMES; i++) {
      throwIfStopped();

      if (!(await switchToTab('SEASON'))) {
        console.warn('  ⚠️ Skipping season phase — tab unavailable');
        break;
      }

      const left = readDailyGamesLeft();
      if (left !== null) console.log(`  📅 Daily games left today: ${left}`);

      let playBtn;
      try {
        playBtn = await waitFor(() => findPlayGameButton(), { timeout: 5000, label: 'Season PLAY GAME button' });
      } catch (e) {
        if (isStop(e)) throw e;
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
        reportMatch(`season ${i} ${result || 'unknown'}`);
      } catch (err) {
        if (isStop(err)) throw err;
        console.error(`  ❌ Season game ${i} failed: ${err.message}`);
        post({ type: 'error', text: `Season game ${i}: ${err.message}`, source: 'season' });
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
    console.log(`\n  🏀 Season phase done — ${played} played (${wins}W-${losses}L)`);
    return { played, wins, losses };
  }

  // ==================== PHASE 2: SCRIMMAGE ====================

  async function runScrimmagePhase({ fallbackCount = 100, restBetween = 1200, maxFailures = 3 } = {}) {
    console.log('\n═══ PHASE 2: SCRIMMAGE ═══');
    await switchToTab('SCRIMMAGE');

    // fallbackCount <= 0 means "Full session": play out whatever the rewards
    // counter says is left, and stop when it fills.
    //
    // Any explicit count means exactly that many matches, REGARDLESS of the
    // rewards counter. Rewards capping out does not stop you playing, so the
    // harness should not either — previously an explicit count was clamped to
    // the remaining rewards, which silently produced zero matches at 100/100.
    const auto = !(fallbackCount > 0);
    const respectCap = auto;

    const startCounter = readRewardsCounter();
    let target;

    if (startCounter) {
      console.log(`🎁 Rewards: ${startCounter.current}/${startCounter.total}`);

      if (respectCap) {
        if (startCounter.remaining === 0) {
          console.log('🛑 Rewards are already full — nothing left to earn.');
          post({
            type: 'status',
            text: 'Rewards are already full. To keep playing anyway, choose Quick or ' +
                  'Standard, or type a number of matches.'
          });
          return { completed: 0, failed: 0, wins: 0, losses: 0, reason: 'cap-reached' };
        }
        target = startCounter.remaining;
      } else {
        target = fallbackCount;
        if (startCounter.remaining === 0) {
          console.log('ℹ️ Rewards are full — playing for practice, no rewards will be earned.');
          post({ type: 'status', text: 'Rewards are full — playing on anyway.' });
        }
      }
    } else {
      // Counter unreadable — never invent a huge number in auto mode.
      target = auto ? 25 : fallbackCount;
      console.warn(`⚠️ Rewards counter unreadable — defaulting to ${target} matches.`);
    }

    plannedTotal = matchesDone + target;

    post({
      type: 'status',
      text: startCounter
        ? `${target} match(es) queued — rewards at ${startCounter.current}/${startCounter.total}.`
        : `${target} match(es) queued.`
    });

    let completed = 0, failed = 0, wins = 0, losses = 0, consecutiveFailures = 0;
    await resumeIfMatchInProgress();

    for (let i = 1; i <= target; i++) {
      throwIfStopped();

      const counter = readRewardsCounter();
      if (counter) {
        // Only "Full session" treats a full counter as a reason to stop.
        if (respectCap && counter.remaining === 0) {
          console.log(`\n🎉 Rewards full (${counter.current}/${counter.total}). Stopping.`);
          break;
        }
        console.log(`\n▶️ Match ${i}/${target} | Rewards: ${counter.current}/${counter.total}`);
      } else {
        console.log(`\n▶️ Match ${i}/${target}`);
      }

      let monitor = null, result = null;
      try {
        await clickQuickPlayWhenJoinGone();
        console.log('  ✅ QUICK PLAY clicked — match starting');
        monitor = startInMatchMonitor();
        result = await clickContinueWhenMatchEnds();
        console.log('  ✅ CONTINUE clicked — exiting summary');
        if (result === 'VICTORY') wins++;
        else if (result === 'DEFEAT') losses++;
        completed++;
        consecutiveFailures = 0;
        reportMatch(`scrimmage ${i} ${result || 'unknown'}`);
      } catch (err) {
        if (isStop(err)) throw err;
        failed++;
        consecutiveFailures++;
        console.error(`  ❌ Match ${i} failed: ${err.message}`);
        post({ type: 'error', text: `Match ${i}: ${err.message}`, source: 'scrimmage' });

        // Retry Threshold from the host: bail out rather than spin forever.
        if (consecutiveFailures > maxFailures) {
          console.error(`  🛑 ${consecutiveFailures} consecutive failures — aborting scrimmage phase.`);
          break;
        }

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

      if (result === 'DEFEAT') {
        console.log(`  ⏳ Defeat — waiting ${DEFEAT_DELAY / 1000}s`);
        await sleep(DEFEAT_DELAY);
      }
      try {
        await waitForLobby();
      } catch (e) {
        if (isStop(e)) throw e;
      }
      if (result !== 'DEFEAT') await sleep(restBetween);
    }
    return { completed, failed, wins, losses };
  }

  // ==================== ORCHESTRATOR ====================

  /**
   * Runs the one-time configuration overlay walkthrough before any match.
   * The module lives in session-init.js and is injected ahead of this file;
   * if it is absent the run continues rather than failing, since the presets
   * are setup convenience, not a hard requirement.
   */
  async function initialiseWorkspace(opts) {
    if (typeof window.initializeSession !== 'function') {
      console.warn('[automation] session-init.js not loaded — skipping workspace setup.');
      return { ok: false, skipped: true };
    }

    const result = await window.initializeSession({
      triggerLabel: opts.triggerLabel || 'CONFIG_PANEL',
      primaryOption: opts.primaryOption || 'PRESET_OFFENSE_A',
      secondaryOption: opts.secondaryOption || 'PRESET_DEFENSE_B',
      // Honours the harness Stop button: waits abort instead of running out
      // their full timeout.
      isCancelled: () => stopped
    });

    if (result.skipped) console.log('[automation] workspace already configured.');
    else if (result.ok) console.log('[automation] workspace presets applied.');
    else console.warn('[automation] workspace setup incomplete:', result.error);

    return result;
  }

  async function runAll(opts = {}) {
    console.log('🚀 Starting automation — open Match Hall, workspace setup, Season, then Scrimmage');

    post({ type: 'status', text: 'Opening the Match Hall...' });
    const hallOpen = await openMatchHall();
    throwIfStopped();

    if (!hallOpen) {
      throw new Error('Could not open the Match Hall — nothing to automate.');
    }

    await initialiseWorkspace(opts);
    throwIfStopped();

    const season = await runSeasonPhase();
    throwIfStopped();
    const scrimmage = await runScrimmagePhase(opts);

    const totalWins = season.wins + scrimmage.wins;
    const totalLosses = season.losses + scrimmage.losses;
    const played = totalWins + totalLosses;
    const winrate = played > 0 ? ((totalWins / played) * 100).toFixed(1) : '0.0';
    const final = readRewardsCounter();

    console.log('\n═══ SESSION COMPLETE ═══');
    console.log(`🏀 Season: ${season.played} played (${season.wins}W-${season.losses}L)`);
    console.log(`🏆 Scrimmage: ${scrimmage.completed} completed, ${scrimmage.failed} failed`);
    console.log(`📈 Overall: ${totalWins}W - ${totalLosses}L | Winrate: ${winrate}%`);
    if (final) console.log(`🎁 Final rewards: ${final.current}/${final.total}`);
    return { season, scrimmage };
  }

  // ==================== HOST ENTRY POINTS ====================

  window.startLoop = function (cfg) {
    if (running) {
      post({ type: 'error', text: 'startLoop ignored — a run is already active.', source: 'automation' });
      return 'already-running';
    }

    config = Object.assign({
      targetIterations: 25,   // 0 or less = play until the reward cap
      actionDelayMs: 1200,
      retryThreshold: 3,
      verbose: false
    }, cfg || {});

    const autoTarget = !(config.targetIterations > 0);

    stopped = false;
    running = true;
    matchesDone = 0;
    // Provisional. runScrimmagePhase corrects it once the rewards counter has
    // been read, and every progress message carries the corrected total.
    plannedTotal = MAX_SEASON_GAMES + (autoTarget ? 0 : config.targetIterations);

    // A fresh Start is a new session cycle, so the once-only guard resets.
    if (typeof window.resetSessionInit === 'function') window.resetSessionInit();

    post({ type: 'started', total: plannedTotal });
    post({
      type: 'status',
      text: autoTarget
        ? `Starting — playing until the reward cap, resting ` +
          `${(config.actionDelayMs / 1000).toFixed(1)}s between matches.`
        : `Starting — up to ${config.targetIterations} matches, resting ` +
          `${(config.actionDelayMs / 1000).toFixed(1)}s between each.`
    });

    // Not awaited: ExecuteScriptAsync returns immediately and the host is
    // driven entirely by postMessage from here on.
    (async function () {
      let cancelled = false;
      try {
        await runAll({
          fallbackCount: config.targetIterations,
          restBetween: config.actionDelayMs,
          maxFailures: config.retryThreshold
        });
      } catch (err) {
        if (isStop(err)) {
          cancelled = true;
          console.warn('[automation] run cancelled.');
        } else {
          console.error('[automation] fatal:', err && err.message);
          post({ type: 'error', text: 'Fatal: ' + (err && err.message), source: 'automation' });
        }
      } finally {
        // This block is the contract with the host. If it never runs, the
        // Start button stays disabled — which is exactly the bug this fixes.
        if (activeMonitor) { try { activeMonitor.stop(); } catch (_) { } }
        abortAllWaits();
        running = false;
        stopped = false;
        post({
          type: 'done',
          current: matchesDone,
          total: Math.max(plannedTotal, matchesDone),
          succeeded: matchesDone,
          failed: 0,
          cancelled: cancelled
        });
      }
    })();

    return 'started';
  };

  window.stopLoop = function () {
    if (!running) {
      post({ type: 'status', text: 'stopLoop(): nothing is running.' });
      post({ type: 'done', current: matchesDone, total: plannedTotal, cancelled: true });
      return 'idle';
    }
    stopped = true;
    if (activeMonitor) { try { activeMonitor.stop(); } catch (_) { } }
    abortAllWaits();   // aborts sleeps and waiters immediately
    console.warn('[automation] stopLoop() — aborting in-flight waits.');
    post({ type: 'status', text: 'Cancelling — aborting current wait.' });
    return 'stopping';
  };

  /** Host safety valve: clears state even if a run went off the rails. */
  window.__resetAutomation = function () {
    stopped = false;
    running = false;
    if (activeMonitor) { try { activeMonitor.stop(); } catch (_) { } }
    abortAllWaits();
    return 'reset';
  };

  window.loopStatus = function () {
    return { running, stopped, matchesDone, plannedTotal, pendingWaits: cancellers.size };
  };

  // Host bridge helpers, exposed for manual testing from DevTools (F12):
  //   sendMatchSummaryToHost('VICTORY', 118, 104, '[MNR] S1MPLE')
  window.sendMatchSummaryToHost = sendMatchSummaryToHost;
  window.sendLogToHost = sendLogToHost;
  window.readFinalScore = readFinalScore;
  window.readMvpCard = readMvpCard;
  window.readOpponentName = readOpponentName;
  window.tidyHandle = tidyHandle;
  window.reportMatchSummary = reportMatchSummary;
  window.dumpScoreCandidates = dumpScoreCandidates;
  window.collectScoreNumbers = collectScoreNumbers;
  window.openMatchHall = openMatchHall;
  window.findDockButton = findDockButton;
  window.isMatchHallOpen = isMatchHallOpen;

  // Manual console bindings, unchanged
  window.readRewardsCounter = readRewardsCounter;
  window.readDailyGamesLeft = readDailyGamesLeft;
  window.findPlayGameButton = findPlayGameButton;
  window.readActivePropBanner = readActivePropBanner;
  window.findCloseButton = findCloseButton;
  window.closePropMenu = closePropMenu;
  window.readOpponentMorale = readOpponentMorale;
  window.findTimeoutButton = findTimeoutButton;
  window.deepText = deepText;
  window.readMatchResult = readMatchResult;
  window.callTimeout = callTimeout;
  window.runSeasonPhase = runSeasonPhase;
  window.runScrimmagePhase = runScrimmagePhase;
  window.runAll = runAll;

  console.info('[automation] Hoops Arena bundle installed — waiting for Start.');
})();
