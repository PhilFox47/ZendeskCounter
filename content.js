// Injected into the Zendesk Agent Workspace to auto-detect when you're in an
// active chat or on a call, so that time can be tracked (and later deducted
// from productive time). It reads the page DOM only — it never reads ticket
// content — and reports a coarse presence state ("idle" | "chat" | "call") to
// the background worker, which does the timing.
//
// Detection is intentionally verbose in what it logs, because the exact DOM
// states vary; the popup can export those logs to calibrate the heuristics.

(() => {
  const POLL_MS = 5000;
  const HEARTBEAT_MS = 15000;

  let lastState = null;
  let lastSignalsKey = "";
  let lastHeartbeat = 0;

  function parseRgb(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || "");
    if (!m) return null;
    const [r, g, b] = m[1].split(",").map((x) => parseFloat(x));
    return { r, g, b };
  }

  // A Zendesk garden status indicator is "green" (active chat) when its green
  // channel clearly dominates. Kept lenient; logs carry the raw color so the
  // threshold can be tuned.
  function isGreen(rgb) {
    if (!rgb) return false;
    const { r, g, b } = rgb;
    return g >= 100 && g >= r + 25 && g >= b + 25;
  }

  function indicatorColor(el) {
    if (!el) return null;
    const cs = getComputedStyle(el);
    // Garden sets the dot color via background-color, sometimes border/box-shadow.
    return (
      parseRgb(cs.backgroundColor) ||
      parseRgb(cs.borderTopColor) ||
      parseRgb(cs.color)
    );
  }

  function scanSignals() {
    const tabs = [];
    let chatTabs = 0;
    for (const tab of document.querySelectorAll('[data-test-id="header-tab"]')) {
      const indicator = tab.querySelector('[data-garden-id="avatars.status_indicator"]');
      const rgb = indicatorColor(indicator);
      const green = isGreen(rgb);
      if (green) chatTabs += 1;
      tabs.push({
        id: tab.getAttribute("data-entity-id") || null,
        status: tab.getAttribute("data-entity-status") || null,
        badge: tab.getAttribute("data-entity-badge") || null,
        color: rgb ? `${Math.round(rgb.r)},${Math.round(rgb.g)},${Math.round(rgb.b)}` : null,
        green,
      });
    }

    // Phone: the Talk top-nav control's test-id suffix encodes state, and the
    // in-ticket call controls bar gets populated during a live call.
    const talkBtn = document.querySelector('[data-test-id^="talk-top-nav-control-"]');
    const talkSuffix = talkBtn
      ? (talkBtn.getAttribute("data-test-id") || "").replace("talk-top-nav-control-", "")
      : null;
    const callBar = document.querySelector('[data-test-id="ticket-call-controls-action-bar"]');
    const callBarActive = !!(callBar && callBar.childElementCount > 0);
    // Idle-ish Talk states that are NOT a call. Anything else with a talk button
    // present (e.g. on-call / connected / wrap-up) is treated as a call.
    const TALK_IDLE = new Set(["offline", "available", "online", "away", "transfers-only", "transfersonly", ""]);
    const talkOnCall = callBarActive || (talkSuffix != null && !TALK_IDLE.has(talkSuffix));

    return { tabs, chatTabs, talkSuffix, callBarActive, talkOnCall };
  }

  function classify(sig) {
    if (sig.talkOnCall) return "call";
    if (sig.chatTabs > 0) return "chat";
    return "idle";
  }

  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch {
      /* extension context invalidated (reload) — ignore */
    }
  }

  function tick() {
    let sig, state;
    try {
      sig = scanSignals();
      state = classify(sig);
    } catch (e) {
      send({ type: "pt-log", level: "error", msg: "scan failed", detail: String(e) });
      return;
    }

    const key = state + "|" + sig.chatTabs + "|" + sig.talkSuffix + "|" + sig.callBarActive;
    const now = Date.now();
    const changed = state !== lastState || key !== lastSignalsKey;

    if (changed) {
      send({
        type: "pt-presence",
        state,
        visible: document.visibilityState === "visible",
        signals: sig,
        changed: true,
      });
      lastState = state;
      lastSignalsKey = key;
      lastHeartbeat = now;
    } else if (now - lastHeartbeat >= HEARTBEAT_MS) {
      send({ type: "pt-presence", state, visible: document.visibilityState === "visible", changed: false });
      lastHeartbeat = now;
    }
  }

  // React quickly to DOM changes (tab open/close, call bar appearing) but
  // debounce so we don't scan on every mutation.
  let debounce = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounce);
    debounce = setTimeout(tick, 400);
  });
  try {
    observer.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["data-entity-status", "data-test-id", "class"] });
  } catch {
    /* body not ready yet — the interval below still covers us */
  }

  document.addEventListener("visibilitychange", tick);
  setInterval(tick, POLL_MS);
  send({ type: "pt-log", level: "info", msg: "content script loaded", detail: location.pathname });
  tick();
})();
