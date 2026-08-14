/* =====================================================================
 * big3.js — session-start + mid-session substitution helper for BIG3 PLAY,
 * looped like Scrimmage/Ranked (Match Count / Rest Between) via
 * window.startBig3Loop(config) / window.stopLoop().
 *
 * All label/attribute defaults (MATCH_ZONE, QUEUE_SESSION, SECONDARY_ACTION,
 * BENCH_PANEL, data-role, CONTINUE) are placeholders from the original spec,
 * not verified against real BIG3 markup — tune once it's known, same as
 * automation.js's own "heuristics" comments describe for its selectors.
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
  // Same "is the overlay open, if not click MATCH in the bottom dock"
  // pattern as automation.js's openMatchHall() — ported rather than
  // reimplemented so both scripts agree on what "the primary dashboard" is.

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

  function isPrimaryDashboardOpen() {
    for (const el of document.querySelectorAll('body *')) {
      if (!isVisible(el)) continue;
      if (directText(el).toUpperCase().replace(/\s+/g, ' ').trim() === 'MATCH HALL') return true;
    }
    return findTab('SCRIMMAGE') !== null;
  }

  async function openPrimaryDashboard({ timeout = 15000 } = {}) {
    if (isPrimaryDashboardOpen()) return true;

    const btn = findDockButton('MATCH');
    if (!btn) {
      logToHost('Could not find the MATCH button in the bottom dock.', 'error');
      return false;
    }
    triggerClick(btn);

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
   * active session view" — defaults to a phase indicator (Q1/PHASE 1, etc.)
   * appearing, since that's the one thing guaranteed to exist once a session
   * actually starts. Override it once the real active-session markup for
   * BIG3 is known.
   */
  async function startSessionQueue({
    targetTabLabel = 'MATCH_ZONE',
    queueButtonLabel = 'QUEUE_SESSION',
    isActiveSession = () => readPhaseIndicator() !== null,
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

  let hasSubstitutedThisSession = false;

  /**
   * Small, standalone phase/quarter label — "Q2", "PHASE 2", etc. Matched as
   * an exact, short piece of text rather than a substring so it can't pick
   * up an unrelated sentence that happens to mention a phase in passing.
   */
  function readPhaseIndicator() {
    const el = [...document.querySelectorAll('body *')].find(node =>
      isVisible(node) && /^(Q\d+|PHASE\s*\d+)$/i.test(directText(node)));
    return el ? directText(el).toUpperCase().replace(/\s+/g, ' ') : null;
  }

  function isTargetPhase(phaseText, targetPhase) {
    if (!phaseText) return false;
    const normalize = s => s.toUpperCase().replace(/\s+/g, ' ').replace(/^PHASE\s*/, 'Q');
    return normalize(phaseText) === normalize(targetPhase);
  }

  /**
   * Runs once per session: on detecting the target phase, opens the
   * substitution drawer, picks the first available bench card, clicks the
   * matching role slot in the main workspace, then closes the drawer.
   *
   * Scoping is deliberate: every lookup after the drawer is found is scoped
   * to `drawer`, not `document` — a same-labelled element sitting in the
   * base layout behind the overlay must never be mis-clicked as if it were
   * part of the drawer's contents. The one exception is the destination
   * slot, which by definition lives in the main workspace outside the
   * drawer, so that lookup explicitly excludes anything inside `drawer`.
   */
  async function performMidSessionSwap({
    actionButtonLabel = 'SECONDARY_ACTION',
    drawerPanelLabel = 'BENCH_PANEL',
    targetPhase = 'Q2',
    roleAttribute = 'data-role',
    timeout = 15000
  } = {}) {
    if (hasSubstitutedThisSession) return false;

    const phaseText = readPhaseIndicator();
    if (!isTargetPhase(phaseText, targetPhase)) return false;

    try {
      logToHost(`Phase ${phaseText} detected — starting substitution.`);

      const actionBtn = findByLabel(actionButtonLabel);
      if (!actionBtn || !isEnabled(actionBtn)) {
        throw new Error(`"${actionButtonLabel}" control not found or not enabled.`);
      }
      triggerClick(actionBtn);

      // Found by its own heading text, then climbed to a container that
      // holds more than just the heading — the panel itself, not the label.
      const drawer = await waitFor(() => {
        const heading = [...document.querySelectorAll('body *')].find(el =>
          isVisible(el) && directText(el).toUpperCase() === drawerPanelLabel.toUpperCase());
        if (!heading) return null;
        let node = heading.parentElement;
        for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
          if (node.querySelectorAll(CLICKABLE).length > 1) return node;
        }
        return heading.parentElement || heading;
      }, { timeout, label: `${drawerPanelLabel} drawer` });

      logToHost(`"${drawerPanelLabel}" drawer open.`);

      const card = await waitFor(() => {
        const candidates = [...drawer.querySelectorAll(`[${roleAttribute}]`)]
          .filter(el => isVisible(el) && isEnabled(el));
        return candidates[0] || null;
      }, { timeout, label: 'first available bench card', root: drawer });

      const role = card.getAttribute(roleAttribute);
      if (!role) throw new Error('Bench card has no role tag to match against.');

      triggerClick(card);
      logToHost(`Selected bench card (role="${role}").`);
      await sleep(400);

      // The destination slot lives in the main workspace, outside the
      // drawer — the one lookup here that must NOT be scoped to it.
      const slot = [...document.querySelectorAll(`[${roleAttribute}="${role}"]`)]
        .find(el => !drawer.contains(el) && isVisible(el) && isEnabled(el));
      if (!slot) throw new Error(`No matching "${role}" slot found in the main workspace.`);

      triggerClick(slot);
      logToHost(`Placed into matching "${role}" slot — substitution complete.`);
      await sleep(400);

      const closeBtn =
        [...drawer.querySelectorAll('[aria-label]')].find(el =>
          /close/i.test(el.getAttribute('aria-label') || '') && isVisible(el)) ||
        [...drawer.querySelectorAll('[class*="close" i]')].find(el => isVisible(el) && isEnabled(el));

      if (closeBtn) {
        triggerClick(closeBtn);
        logToHost('Closed the substitution drawer.');
      } else {
        logToHost('No dedicated close control found for the drawer — leaving it open.', 'warn');
      }

      hasSubstitutedThisSession = true;
      return true;
    } catch (err) {
      logToHost(`performMidSessionSwap() failed: ${err.message}`, 'error');
      return false;
    }
  }

  // ==================== SESSION MONITOR ====================
  // A cheap, infrequent background watcher for the length of the active
  // session — not a tight automation loop — that fires the once-only
  // substitution the moment the target phase shows up.

  let monitorTimer = null;

  function startSessionMonitor(swapOptions = {}, { interval = 2000 } = {}) {
    stopSessionMonitor();
    monitorTimer = setInterval(async () => {
      try {
        await performMidSessionSwap(swapOptions);
      } catch (err) {
        logToHost(`Session monitor tick failed: ${err.message}`, 'error');
      }
    }, interval);
    return { stop: stopSessionMonitor };
  }

  function stopSessionMonitor() {
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  }

  // ==================== SESSION END ====================
  // The spec covers session start and the mid-session swap, but not how one
  // session ends — needed here since the loop below has to know when to
  // queue the next one. Every other match-ending screen on this site
  // resolves via a CONTINUE button (see automation.js/ranked.js), so that's
  // the default; override continueButtonLabel once BIG3's real end screen
  // is confirmed if it differs.
  async function waitForSessionEnd({
    continueButtonLabel = 'CONTINUE',
    timeout = 6 * 60 * 1000
  } = {}) {
    const continueBtn = await waitFor(
      () => findByLabel(continueButtonLabel),
      { timeout, stableFor: 500, label: `${continueButtonLabel} (session end)` }
    );
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
      stopSessionMonitor();

      logToHost(`Session ${i}/${sessionLimit} — queueing.`);

      try {
        const queued = await startSessionQueue(config);
        if (!queued) throw new Error('Could not queue a session.');

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

  // Exposed for DevTools debugging, same convention as automation.js/ranked.js.
  window.readPhaseIndicator = readPhaseIndicator;
  window.performMidSessionSwap = performMidSessionSwap;
})();
