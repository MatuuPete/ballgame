/* =====================================================================
 * big3.js — session-start + mid-session substitution helper for BIG3 PLAY,
 * looped like Scrimmage/Ranked (Match Count / Rest Between) via
 * window.startBig3Loop(config) / window.stopLoop().
 *
 * BIG3 turned out not to be a distinct mode on the real site — it plays
 * ordinary Scrimmage games, so targetTabLabel/queueButtonLabel are the
 * confirmed real values ("SCRIMMAGE" / "QUICK PLAY", same as automation.js
 * uses). The mid-session bench swap (executeBenchSwap, shared by both
 * directions below) is built and confirmed working against real screenshots
 * of the live match screen, the Control Deck "SUB" button, and the "BENCH"
 * drawer — including findMatchingCourtSlot() scoping to the left half of
 * the court, which is what made step 2 ("choose who goes out") resolve to
 * the right player instead of an ambiguous guess.
 *
 * Two swaps happen per session, both role-based rather than tracking player
 * identity: performMidSessionSwap() subs in the first available bench
 * player at Q2/11:00 and remembers the SLOT it filled (lastSubbedRole);
 * performReturnSwap() fills that same slot again at Q2/3:00 with whichever
 * bench player is ELIGIBLE for it — not necessarily their own first-listed
 * position (see findAvailableBenchCard's requiredRole handling: a player
 * tagged "SF/PF" who was benched out of the PF slot is still found, since
 * PF is in their list even though it isn't listed first).
 *
 * Reuses the same DOM primitives and waitFor pattern as automation.js /
 * ranked.js for consistency, rather than reinventing them.
 * ===================================================================== */
(function () {
  'use strict';

  const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

  // ==================== HOST BRIDGE ====================
  // window.__wpf is installed by bridge.js before this script runs. Used for
  // the started/progress/done loop-control messages, matching ranked.js's
  // contract; the LOG channel below is separate, matching the spec exactly.
  const bridge = (typeof window !== 'undefined' && window.__wpf) || { send() {}, status() {} };

  // ==================== HOST LOGGING ====================
  // Spec calls for the raw postMessage shape directly (not the bridge.js
  // wrapper other scripts use) — { type: "LOG", message }, which is exactly
  // what BridgeMessage.Message on the C# side already accepts as an alias
  // for Text, so this needs no host-side changes.
  function logToHost(message, level) {
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function') {
        window.chrome.webview.postMessage({ type: 'LOG', level: level || 'info', message: String(message) });
      }
    } catch (_) { /* logging must never break the flow it's reporting on */ }

    if (level === 'error') console.error('[big3] ' + message);
    else if (level === 'warn') console.warn('[big3] ' + message);
    else console.log('[big3] ' + message);
  }

  // ==================== DOM HELPERS ====================

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

  function findByLabel(label, root = document) {
    const target = label.toUpperCase();
    return [...root.querySelectorAll(CLICKABLE)].find(el => {
      const text = directText(el).toUpperCase();
      return (text === target || text.split(' ').includes(target)) && isVisible(el);
    }) || null;
  }

  function findTab(label, root = document) {
    const target = label.toUpperCase();
    const selector = `${CLICKABLE}, li, span, div`;
    return [...root.querySelectorAll(selector)].find(el => {
      const own = directText(el).toUpperCase().replace(/\s+/g, ' ');
      return own === target && isVisible(el);
    }) || null;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Same generic waiter used elsewhere in this app: a MutationObserver
   * (reacts to real DOM changes) plus a slow interval as a backstop,
   * debounced so a burst of mutations runs condition() once rather than
   * once per mutation. `root` lets a caller scope the observer to a
   * specific overlay instead of the whole document.
   */
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

  // ==================== DASHBOARD / TAB NAVIGATION ====================
  // Same pattern as automation.js's openMatchHall() — ported rather than
  // reimplemented so all three scripts agree on what "the primary
  // dashboard" is. Interface update: the bottom dock's MATCH button was
  // replaced by a CITY button that opens a city-map overlay; reaching the
  // dashboard now means clicking CITY, then the STADIUM building on that map.

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
    const labelEl = hits.reduce((a, b) => (a.area <= b.area ? a : b)).el;
    return labelEl.closest(CLICKABLE) || labelEl.parentElement || labelEl;
  }

  function isPrimaryDashboardOpen() {
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      if (directText(el).toUpperCase().replace(/\s+/g, ' ').trim() === 'MATCH HALL') return true;
    }
    return findTab('SCRIMMAGE') !== null;
  }

  async function openPrimaryDashboard({ timeout = 15000 } = {}) {
    if (isPrimaryDashboardOpen()) return true;

    const cityBtn = findDockButton('CITY');
    if (!cityBtn) {
      logToHost('Could not find the CITY button in the bottom dock.', 'error');
      return false;
    }
    triggerClick(cityBtn);

    let stadiumBtn;
    try {
      stadiumBtn = await waitFor(() => findMapLabel('STADIUM'),
        { timeout, stableFor: 300, interval: 200, label: 'STADIUM building' });
    } catch (err) {
      logToHost('STADIUM building did not appear: ' + err.message, 'error');
      return false;
    }
    triggerClick(stadiumBtn);

    try {
      await waitFor(() => isPrimaryDashboardOpen() || null,
        { timeout, stableFor: 300, interval: 200, label: 'primary dashboard to open' });
      return true;
    } catch (err) {
      logToHost('Primary dashboard did not open in time: ' + err.message, 'error');
      return false;
    }
  }

  // ==================== PART 1: STARTUP & SESSION QUEUE ====================

  let hasQueuedSession = false;

  /**
   * Runs once per session lifecycle, on Start. Opens the primary dashboard
   * if needed, switches to the target tab, waits for the queue button to
   * become enabled, clicks it, then waits for the active-session view.
   *
   * `isActiveSession` is a caller-supplied condition() for "we're now in the
   * active session view" — defaults to the quarter indicator (Q1, Q2, etc.,
   * confirmed real — see readQuarter() below) appearing, since that's the
   * one thing guaranteed to exist once a match actually starts.
   */
  async function startSessionQueue({
    targetTabLabel = 'SCRIMMAGE',
    queueButtonLabel = 'QUICK PLAY',
    isActiveSession = () => readQuarter() !== null,
    timeout = 30000
  } = {}) {
    if (hasQueuedSession) {
      logToHost('startSessionQueue() skipped — a session is already queued this lifecycle.');
      return false;
    }

    try {
      const dashboardReady = await openPrimaryDashboard({ timeout });
      if (!dashboardReady) throw new Error('Primary dashboard is not available.');

      const tab = findTab(targetTabLabel);
      if (!tab) throw new Error(`Could not find the "${targetTabLabel}" tab.`);
      triggerClick(tab);
      logToHost(`Switched to "${targetTabLabel}".`);
      await sleep(1000);

      const queueBtn = await waitFor(
        () => {
          const btn = findByLabel(queueButtonLabel);
          return btn && isEnabled(btn) ? btn : null;
        },
        { timeout, label: `${queueButtonLabel} button` }
      );

      triggerClick(queueBtn);
      logToHost(`Clicked "${queueButtonLabel}" — entering queue.`);

      await waitFor(isActiveSession, { timeout, label: 'active session view' });
      logToHost('Active session view detected.');

      hasQueuedSession = true;
      return true;
    } catch (err) {
      logToHost(`startSessionQueue() failed: ${err.message}`, 'error');
      return false;
    }
  }

  // ==================== PART 2: MID-SESSION STATE SWAP ====================
  // Rebuilt against real screenshots of the live match screen, the SUB
  // button, and the BENCH drawer — see the confirmed-vs-unconfirmed notes
  // below. Standard basketball position abbreviations, used throughout.

  let hasSubstitutedThisSession = false;
  let hasReturnedThisSession = false;
  let lastSubbedRole = null;

  // A bench/court badge can show a single position ("PF") or a combo of
  // several a player is eligible for ("SF/PF/C") — matches either.
  const POSITION_PATTERN = /^(PG|SG|SF|PF|C)(\/(PG|SG|SF|PF|C))*$/;

  function positionsOf(text) {
    return text.trim().toUpperCase().split('/').map(s => s.trim()).filter(Boolean);
  }

  /**
   * For a combo like "SF/PF/C", the PRIMARY role is the first one — used
   * when a card determines its OWN role (e.g. the initial swap's bench pick
   * doesn't have a target slot yet, so it adopts its first position as one).
   */
  function firstPosition(text) {
    return positionsOf(text)[0];
  }

  /**
   * Small, standalone quarter label — "Q1".."Q4". Matched as an exact, short
   * piece of text rather than a substring so it can't pick up an unrelated
   * sentence that happens to mention a quarter in passing.
   */
  function readQuarter() {
    const el = [...document.querySelectorAll('body *')].find(node =>
      isVisible(node) && /^Q\d+$/i.test(directText(node)));
    return el ? directText(el).toUpperCase() : null;
  }

  /**
   * The live match clock ("1:59", "11:23", etc.), in seconds remaining.
   * Matched narrowly (1-2 digits, colon, exactly 2 digits) so it can't
   * collide with other H:MM:SS-style countdowns elsewhere on the site (e.g.
   * the Season "RESET 01:35:20" timer, which has three segments, not two).
   */
  function readGameClockSeconds() {
    const el = [...document.querySelectorAll('body *')].find(node =>
      isVisible(node) && /^\d{1,2}:\d{2}$/.test(directText(node)));
    if (!el) return null;
    const [min, sec] = directText(el).split(':').map(Number);
    return min * 60 + sec;
  }

  /**
   * Control Deck button. CONFIRMED real label: "SUB" over a "BENCH"
   * sub-label — same two-line layout as the TO button ("TO" / "2 LEFT"), so
   * reuses the same deepText + word-boundary + bottom-right-quadrant
   * approach findTimeoutButton() already uses for that reason: a plain
   * ownText/ownership match would miss it if "SUB" and "BENCH" are on
   * separate child spans (confirmed likely, see findBenchDrawer below).
   */
  function findSubButton() {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const candidates = [...document.querySelectorAll(CLICKABLE)].filter(el => {
      if (!isVisible(el) || !isEnabled(el)) return false;
      if (!/\bSUB\b/.test(deepText(el))) return false;
      const rect = el.getBoundingClientRect();
      return rect.left > vw * 0.5 && rect.top > vh * 0.5;
    });
    if (!candidates.length) return null;
    return candidates.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
  }

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

  /**
   * CONFIRMED real drawer title: "BENCH". Not used as a bare exact-text
   * match, though — the SUB button's own sub-label is very likely also its
   * own element reading exactly "BENCH" (same split-label pattern as its
   * "SUB" half), which would otherwise make this resolve to the Control
   * Deck button instead of the actual overlay. Disambiguated by requiring
   * the candidate's container to also hold "CHOOSE WHO" — text confirmed
   * present in the real drawer ("1. Choose who comes in") and not
   * plausible anywhere near a small dock button.
   */
  function findBenchDrawer(drawerPanelLabel) {
    const headings = [...document.querySelectorAll('body *')].filter(el =>
      isVisible(el) && directText(el).toUpperCase().trim() === drawerPanelLabel.toUpperCase());

    for (const heading of headings) {
      let node = heading.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const text = (node.textContent || '').toUpperCase();
        if (text.includes('CHOOSE WHO') && node.querySelectorAll(CLICKABLE).length > 1) {
          return node;
        }
      }
    }
    return null;
  }

  /**
   * Available bench card, scoped to `drawer`. CONFIRMED: a card's role is
   * rendered as plain visible text — either a single position ("PF") or a
   * combo of everything the player is eligible for ("SF/PF/C") — not a data
   * attribute. An empty slot shows "OPEN" instead, which POSITION_PATTERN
   * naturally excludes. Returns the smallest matching element (the role
   * badge itself) climbed to its nearest clickable ancestor — the card, not
   * just the badge.
   *
   * `requiredRole`, when given, narrows to a bench card ELIGIBLE for that
   * slot — i.e. the role appears anywhere in its position list, not
   * necessarily first. This matters for the return-swap below: the player
   * being brought back may have been playing a slot that isn't their own
   * first-listed position (e.g. tagged "SF/PF" but subbed out of the PF
   * slot) — requiring an exact first-position match missed that case
   * entirely and just timed out. When requiredRole is set, the returned
   * role IS requiredRole (the specific slot being targeted), not the card's
   * own first position — using the card's own primary position instead
   * would send the player to the wrong slot. Left undefined for the initial
   * swap, which has no predetermined target and adopts whichever card comes
   * up first, using ITS primary (first-listed) position.
   */
  function findAvailableBenchCard(drawer, requiredRole) {
    const candidates = [...drawer.querySelectorAll('*')].filter(el =>
      isVisible(el) && isEnabled(el) && POSITION_PATTERN.test(directText(el).trim().toUpperCase()));
    const pool = requiredRole
      ? candidates.filter(el => positionsOf(directText(el)).includes(requiredRole))
      : candidates;
    if (!pool.length) return null;

    const badge = pool.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
    return { card: badge.closest(CLICKABLE) || badge, role: requiredRole || firstPosition(directText(badge)) };
  }

  /**
   * CONFIRMED via screenshot + explicit description: press the bench card,
   * then press the on-court starter whose own position pill matches (e.g.
   * bench "PF" -> the starter labelled "PF"). The starting five are each
   * labelled with their own position pill directly below their card —
   * distinct from a player's own multi-position tag like "SF/PF" on the
   * card itself, which an exact match against a single abbreviation like
   * "PF" correctly ignores.
   *
   * CONFIRMED scoping: "the left side positions... will be the constant
   * position my players will be" — the same position label exists on BOTH
   * sides of the court (opponent included), so without this the previous
   * version had no way to tell which side was ours and could click either
   * one. Restricted to the left half of the viewport, which resolves that
   * ambiguity outright rather than guessing between multiple matches.
   */
  function findMatchingCourtSlot(role, drawer) {
    const vw = window.innerWidth;
    const candidates = [...document.querySelectorAll('body *')].filter(el => {
      if (drawer.contains(el) || !isVisible(el) || !isEnabled(el)) return false;
      if (directText(el).trim().toUpperCase() !== role) return false;
      return el.getBoundingClientRect().left < vw * 0.5;
    });
    if (!candidates.length) return { slot: null, ambiguous: false };

    const smallest = candidates.reduce((best, el) => {
      const a = el.getBoundingClientRect();
      const b = best.getBoundingClientRect();
      return (a.width * a.height) < (b.width * b.height) ? el : best;
    });
    return {
      slot: smallest.closest(CLICKABLE) || smallest,
      ambiguous: candidates.length > 1
    };
  }

  /**
   * The actual click sequence, shared by the initial swap and the return
   * swap: open BENCH, pick a bench card (optionally constrained to
   * `requiredRole`), click it, click the matching-position starter, close
   * the drawer. Returns the role that was actually swapped.
   *
   * Scoping is deliberate: every lookup after the drawer is found is scoped
   * to `drawer`, not `document` — a same-labelled element sitting in the
   * base layout behind the overlay must never be mis-clicked as if it were
   * part of the drawer's contents. The one exception is the destination
   * slot, which by definition lives in the main workspace outside the
   * drawer, so that lookup explicitly excludes anything inside `drawer`.
   */
  function closeDrawerIfOpen(drawer, drawerPanelLabel) {
    if (!isVisible(drawer)) return;
    const closeBtn =
      [...drawer.querySelectorAll('[aria-label]')].find(el =>
        /close/i.test(el.getAttribute('aria-label') || '') && isVisible(el)) ||
      [...drawer.querySelectorAll('[class*="close" i]')].find(el => isVisible(el) && isEnabled(el));

    if (closeBtn) {
      triggerClick(closeBtn);
      logToHost('Closed the substitution drawer.');
    } else {
      logToHost(`No dedicated close control found for the "${drawerPanelLabel}" drawer — leaving it open.`, 'warn');
    }
  }

  async function executeBenchSwap(drawerPanelLabel, timeout, requiredRole) {
    const subBtn = findSubButton();
    if (!subBtn) throw new Error('"SUB" control not found in the Control Deck.');
    triggerClick(subBtn);

    const drawer = await waitFor(() => findBenchDrawer(drawerPanelLabel),
      { timeout, label: `${drawerPanelLabel} drawer` });

    logToHost(`"${drawerPanelLabel}" drawer open.`);

    // Once the drawer is open, any failure below must still close it before
    // propagating — otherwise the next monitor tick clicks SUB again against
    // an already-open drawer and the whole thing just flickers open/closed
    // on every retry instead of failing cleanly.
    try {
      const picked = await waitFor(() => findAvailableBenchCard(drawer, requiredRole),
        {
          timeout,
          label: requiredRole ? `bench card (role="${requiredRole}")` : 'first available bench card',
          root: drawer
        });
      const { card, role } = picked;

      triggerClick(card);
      logToHost(`Selected bench card (role="${role}").`);
      await sleep(400);

      const { slot, ambiguous } = findMatchingCourtSlot(role, drawer);
      if (!slot) throw new Error(`No matching "${role}" slot found in the main workspace.`);
      if (ambiguous) {
        logToHost(`More than one "${role}" slot was enabled at once — picked the smallest, ` +
          'but this step is unverified. Please confirm the right player was subbed.', 'warn');
      }

      triggerClick(slot);
      logToHost(`Placed into matching "${role}" slot — swap complete.`);
      await sleep(400);

      closeDrawerIfOpen(drawer, drawerPanelLabel);
      return role;
    } catch (err) {
      closeDrawerIfOpen(drawer, drawerPanelLabel);
      throw err;
    }
  }

  /**
   * Runs once per session: at Q2 with the clock at or below
   * clockThresholdSeconds, subs in the first available bench player.
   * Remembers which position was subbed (lastSubbedRole) so
   * performReturnSwap() below knows who to bring back.
   */
  async function performMidSessionSwap({
    drawerPanelLabel = 'BENCH',
    targetPhase = 'Q2',
    clockThresholdSeconds = 11 * 60,
    timeout = 15000,
    force = false
  } = {}) {
    if (!force) {
      if (hasSubstitutedThisSession) return false;

      const quarter = readQuarter();
      if (!quarter || quarter !== targetPhase.toUpperCase()) return false;

      const clock = readGameClockSeconds();
      if (clock === null || clock > clockThresholdSeconds) return false;
    }

    try {
      if (force) {
        logToHost('Manual substitution requested — starting.');
      } else {
        const quarter = readQuarter();
        const clock = readGameClockSeconds();
        logToHost(`${quarter} at ${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')} — starting substitution.`);
      }

      const role = await executeBenchSwap(drawerPanelLabel, timeout, undefined);
      lastSubbedRole = role;
      hasSubstitutedThisSession = true;
      return true;
    } catch (err) {
      logToHost(`performMidSessionSwap() failed: ${err.message}`, 'error');
      return false;
    }
  }

  /**
   * Runs once per session, after performMidSessionSwap has already fired:
   * at Q2 with the clock at or below returnClockThresholdSeconds, subs the
   * SAME position back — since the sub is role-based, whoever is currently
   * on the bench in that position is, by construction, the player who got
   * subbed out originally, so this is the identical click sequence as the
   * initial swap, just constrained to lastSubbedRole instead of taking the
   * first available card.
   */
  async function performReturnSwap({
    drawerPanelLabel = 'BENCH',
    targetPhase = 'Q2',
    returnClockThresholdSeconds = 3 * 60,
    timeout = 15000,
    force = false
  } = {}) {
    if (!lastSubbedRole) return false;

    if (!force) {
      if (!hasSubstitutedThisSession || hasReturnedThisSession) return false;

      const quarter = readQuarter();
      if (!quarter || quarter !== targetPhase.toUpperCase()) return false;

      const clock = readGameClockSeconds();
      if (clock === null || clock > returnClockThresholdSeconds) return false;
    }

    try {
      if (force) {
        logToHost(`Manual return-sub requested (role="${lastSubbedRole}") — starting.`);
      } else {
        const quarter = readQuarter();
        const clock = readGameClockSeconds();
        logToHost(`${quarter} at ${Math.floor(clock / 60)}:${String(clock % 60).padStart(2, '0')} — bringing back the "${lastSubbedRole}" starter.`);
      }

      await executeBenchSwap(drawerPanelLabel, timeout, lastSubbedRole);
      hasReturnedThisSession = true;
      return true;
    } catch (err) {
      logToHost(`performReturnSwap() failed: ${err.message}`, 'error');
      return false;
    }
  }

  // ==================== SESSION MONITOR ====================
  // A cheap, infrequent background watcher for the length of the active
  // session — not a tight automation loop — that fires the once-only
  // substitution, then the once-only return swap, as their respective
  // triggers are reached. Both gate on their own flags/thresholds, so
  // calling both every tick is safe even before/after either has fired.

  let monitorTimer = null;

  function startSessionMonitor(swapOptions = {}, { interval = 2000 } = {}) {
    stopSessionMonitor();
    monitorTimer = setInterval(async () => {
      try {
        await performMidSessionSwap(swapOptions);
        await performReturnSwap(swapOptions);
      } catch (err) {
        logToHost(`Session monitor tick failed: ${err.message}`, 'error');
      }
    }, interval);
    return { stop: stopSessionMonitor };
  }

  function stopSessionMonitor() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  }

  // ==================== SESSION END + MATCH HISTORY ====================
  // The spec covers session start and the mid-session swap, but not how one
  // session ends — needed here since the loop below has to know when to
  // queue the next one. Every other match-ending screen on this site
  // resolves via a CONTINUE button (see automation.js/ranked.js), so that's
  // the default; override continueButtonLabel once BIG3's real end screen
  // is confirmed if it differs.
  //
  // Since BIG3 plays ordinary Scrimmage games, its post-match summary screen
  // is the same one automation.js already reads — ported here rather than
  // reinvented, same as ranked.js did.

  function readMatchResult() {
    const banner = [...document.querySelectorAll('body *')].find(el => {
      if (!isVisible(el)) return false;
      const own = directText(el).toUpperCase().replace(/[^A-Z]/g, '');
      return own === 'VICTORY' || own === 'DEFEAT';
    });
    if (!banner) return null;
    return directText(banner).toUpperCase().replace(/[^A-Z]/g, '');
  }

  const PLAYER_SCORE_ON_LEFT = true;

  function collectScoreNumbers({ maxTop = 1.0 } = {}) {
    const vh = window.innerHeight;
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const t = directText(el).trim();
      if (!/^\d{1,3}$/.test(t)) continue;
      const n = Number(t);
      if (n > 250) continue;
      const r = el.getBoundingClientRect();
      if (r.top > vh * maxTop) continue;
      out.push({
        n, el,
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
    if (hits.length) return hits.reduce((best, h) => (h.area < best.area ? h : best));

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

  const TAG_PATTERN = /\[[^\]]{1,12}\]/;
  const STAT_LABELS = new Set(['PTS', 'REB', 'AST', 'STL', 'BLK', 'TO', 'MIN', 'FG', '3PT', 'FT', 'PF']);

  function collapseLetterSpacing(s) {
    const parts = String(s || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 3 && parts.every(p => p.length === 1)) return parts.join('');
    return parts.join(' ');
  }

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

  function readOpponentName() {
    const TAGGED = /\[[^\]]{1,12}\]\s*\S+/;
    const tagged = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      const own = directText(el).trim();
      if (!own || own.length > 48) continue;
      if (!TAGGED.test(own.toUpperCase())) continue;
      const rect = el.getBoundingClientRect();
      tagged.push({ name: tidyHandle(own), centerX: rect.left + rect.width / 2 });
    }
    if (!tagged.length) return null;
    tagged.sort((a, b) => b.centerX - a.centerX);
    return tagged[0].name;
  }

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

  function reportMatchSummary(result) {
    const score = readFinalScore();
    const card = readMvpCard();
    const opponent = readOpponentName();

    if (!score) logToHost('Could not read final score — recording 0-0.', 'warn');
    if (!card || !card.mvpName) logToHost('Could not read MVP player name.', 'warn');
    if (!opponent) logToHost('Could not read opponent name.', 'warn');

    return sendMatchSummaryToHost(
      result || 'UNKNOWN',
      score ? score.mine : 0,
      score ? score.theirs : 0,
      card ? card.mvpName : null,
      opponent
    );
  }

  async function waitForSessionEnd({
    continueButtonLabel = 'CONTINUE',
    timeout = 6 * 60 * 1000
  } = {}) {
    const continueBtn = await waitFor(
      () => findByLabel(continueButtonLabel),
      { timeout, stableFor: 500, label: `${continueButtonLabel} (session end)` }
    );

    const result = readMatchResult();
    if (result) logToHost(result === 'VICTORY' ? 'VICTORY' : 'DEFEAT');

    // Read the scoreboard BEFORE clicking CONTINUE — the summary screen is
    // the only place these values exist, and the click tears it down.
    const record = reportMatchSummary(result);
    logToHost(`Recorded: ${record.outcome} ${record.myScore}-${record.opponentScore} vs ${record.opponentName} | MVP ${record.mvpName}`);

    triggerClick(continueBtn);
    await sleep(1000);
  }

  // ==================== HOST ENTRY POINTS ====================

  let stopped = false;

  /**
   * Host entry point, looped like Scrimmage/Ranked. `config` mirrors
   * RunConfig from the WPF host: { targetIterations, actionDelayMs }.
   * targetIterations becomes the session count (0/absent = a large default,
   * i.e. "run until stopped" — BIG3 has no rewards-counter equivalent to
   * cap it against); actionDelayMs becomes the rest between sessions.
   */
  async function runBig3Loop(config = {}) {
    stopped = false;

    const sessionLimit = Number.isFinite(config.targetIterations) && config.targetIterations > 0
      ? config.targetIterations
      : 1000;
    const restBetween = Number.isFinite(config.actionDelayMs) && config.actionDelayMs >= 0
      ? config.actionDelayMs
      : 1200;

    logToHost(`Starting BIG3 automation — up to ${sessionLimit} session(s).`);
    bridge.send('started', { total: sessionLimit });

    let completed = 0, failed = 0;

    for (let i = 1; i <= sessionLimit; i++) {
      if (stopped) break;

      hasQueuedSession = false;
      hasSubstitutedThisSession = false;
      hasReturnedThisSession = false;
      lastSubbedRole = null;
      stopSessionMonitor();

      logToHost(`Session ${i}/${sessionLimit} — queueing.`);

      try {
        const queued = await startSessionQueue(config);
        if (!queued) throw new Error('Could not queue a session.');

        // Without this, StatusText stays frozen on whatever StartButton_Click
        // set ("Starting... Opening the BIG3 queue.") for the ENTIRE first
        // session — 'progress' below only fires once a session finishes, so
        // there was nothing to move it off "Starting..." while a match was
        // actually live.
        bridge.status(`Session ${i}/${sessionLimit} — match in progress.`);

        startSessionMonitor(config);
        await waitForSessionEnd(config);
        completed++;
      } catch (err) {
        failed++;
        logToHost(`Session ${i} failed: ${err.message}`, 'error');
      } finally {
        stopSessionMonitor();
      }

      bridge.send('progress', { current: i, total: sessionLimit });

      if (!stopped) await sleep(restBetween);
    }

    logToHost(`BIG3 automation finished — ${completed} completed, ${failed} failed.`);
    bridge.send('done', {
      current: completed, total: sessionLimit,
      succeeded: completed, failed, cancelled: stopped
    });
  }

  window.startBig3Loop = function (config) {
    // Not awaited — ExecuteScriptAsync must return immediately; the host is
    // driven entirely by postMessage (started/progress/done) from here on,
    // same contract as automation.js's startLoop / ranked.js's
    // startRankedLoop. The .catch is a safety net so a host is never left
    // stuck on a stray throw.
    runBig3Loop(config).catch((err) => {
      logToHost(`Fatal: ${err && err.message}`, 'error');
      bridge.send('done', { current: 0, total: 0, succeeded: 0, failed: 0, cancelled: true });
    });
    return 'started';
  };

  window.stopLoop = () => {
    stopped = true;
    stopSessionMonitor();
  };

  /**
   * Manual override for the "Perform sub now" button — bypasses the Q2 /
   * clock gate entirely (force: true) and resets the once-per-session guard
   * first, so it works regardless of automatic-trigger state and can be
   * pressed more than once per session if needed.
   */
  window.performBig3SubNow = function (config) {
    hasSubstitutedThisSession = false;
    return performMidSessionSwap(Object.assign({}, config, { force: true }));
  };

  /**
   * Manual override for the return swap — same idea, but requires a prior
   * sub to have actually happened (lastSubbedRole set), since there's
   * nothing to bring back otherwise. Exposed for DevTools testing; no UI
   * button wired up for it yet.
   */
  window.performBig3ReturnNow = function (config) {
    hasReturnedThisSession = false;
    return performReturnSwap(Object.assign({}, config, { force: true }));
  };

  // Exposed for DevTools debugging, same convention as automation.js/ranked.js.
  window.readQuarter = readQuarter;
  window.readGameClockSeconds = readGameClockSeconds;
  window.performMidSessionSwap = performMidSessionSwap;
  window.performReturnSwap = performReturnSwap;
})();
