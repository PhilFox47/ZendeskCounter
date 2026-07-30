// Service worker: observes Zendesk Agent Workspace ticket-submit requests,
// counts public replies and solved submits, marks 30-minute productivity
// blocks, and reflects the selected metric on the badge.
//
// Detection is confirmed against captured HAR payloads:
//   POST /api/graphql, "UpdateTicketMutation" (updates) or
//   "CreateIssueTicketMutation" (independent new tickets) — same ticket shape:
//     variables.ticket.comment.isPublic === true  -> public reply
//     variables.ticket.status === "SOLVED"         -> solved
//     (either mutation)                             -> activity -> productive block
//   POST /api/v2/tickets.json (new ticket via side conversation, REST create):
//     ticket.comment present & public !== false     -> public reply (default public)
//     ticket.status === "solved"                    -> solved
//     (any create)                                  -> activity -> productive block
// We only count a submit that completes with an HTTP 2xx, so failed/cancelled
// submits don't inflate anything.

import {
  deltaFromRequest,
  applyActivity,
  normalize,
  metricsForDate,
  todayRates,
  formatRate,
  progressColor,
  addAway,
  normalizeAway,
  mergePresence,
  presenceKind,
  appendLog,
  localDateKey,
  ACCRUE_CAP_SEC,
} from "./detect.js";
import { makeIcons } from "./icon.js";

const STORAGE_KEY = "counterState";
const AWAY_KEY = "awayTime";
const PRESENCE_KEY = "presenceState";
const LOGS_KEY = "ptLogs";

// Ticket updates (replies/solves/notes) go through GraphQL; new tickets go
// through the REST create endpoint. Watch both.
const WATCH_URLS = [
  "*://*.zendesk.com/api/graphql*",
  "*://*.zendesk.com/api/v2/tickets.json*",
];

// requestId -> pending delta captured in onBeforeRequest, consumed in onCompleted.
const pending = new Map();

// Serialize storage read-modify-write so rapid submits don't race.
let writeChain = Promise.resolve();

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      resolve(normalize(res[STORAGE_KEY]));
    });
  });
}

function setState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
  });
}

function decodeRequestBody(requestBody) {
  if (!requestBody) return "";
  if (requestBody.raw && requestBody.raw.length) {
    const decoder = new TextDecoder("utf-8");
    return requestBody.raw
      .map((chunk) => (chunk.bytes ? decoder.decode(chunk.bytes) : ""))
      .join("");
  }
  return "";
}

// Draw today's solved/hr (top) and replies/hr (bottom) onto the toolbar icon,
// and keep the hover tooltip as the detailed breakdown. No badge number.
async function updateAction(state) {
  const s = normalize(state);
  const rates = todayRates(s);
  await chrome.action.setIcon({
    imageData: makeIcons({
      solvedRate: rates.solvedRate,
      repliesRate: rates.repliesRate,
      solvedColor: progressColor(rates.solvedRate, s.goals.solvedPerHour),
      repliesColor: progressColor(rates.repliesRate, s.goals.repliesPerHour),
    }),
  });

  const m = metricsForDate(s);
  await chrome.action.setTitle({
    title:
      `Zendesk today — ${formatRate(m.productiveHours)}h productive\n` +
      `Solved ${formatRate(m.solvedPerHour)}/h (${m.solved}) · ` +
      `Replies ${formatRate(m.repliesPerHour)}/h (${m.replies})`,
  });
}

function commitDelta(delta, when) {
  writeChain = writeChain.then(async () => {
    const state = await getState();
    const next = applyActivity(state, delta, when);
    await setState(next);
    await updateAction(next);
  });
  return writeChain;
}

// 1) Capture the request body as the submit goes out.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const body = decodeRequestBody(details.requestBody);
    const delta = deltaFromRequest(details.url, details.method, body);
    if (delta.activity) {
      pending.set(details.requestId, delta);
    }
  },
  { urls: WATCH_URLS },
  ["requestBody"]
);

// 2) Only count once the submit actually succeeds.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const delta = pending.get(details.requestId);
    if (!delta) return;
    pending.delete(details.requestId);
    if (details.statusCode >= 200 && details.statusCode < 300) {
      commitDelta(delta, new Date());
    }
  },
  { urls: WATCH_URLS }
);

// 3) Clean up on failure so the map doesn't leak.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pending.delete(details.requestId);
  },
  { urls: WATCH_URLS }
);

// Keep the icon correct across service-worker restarts and popup changes.
async function refreshAction() {
  const state = await getState();
  await updateAction(state);
}

chrome.runtime.onStartup.addListener(refreshAction);
chrome.runtime.onInstalled.addListener(refreshAction);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    updateAction(normalize(changes[STORAGE_KEY].newValue));
  }
});

// ---------------------------------------------------------------------------
// Presence: auto-detected active chat / phone time.
//
// Content scripts (one per Zendesk agent tab) report a coarse state
// ("idle" | "chat" | "call"). We merge across tabs (call > chat > idle) and
// accrue elapsed time into awayTime per day. Bookkeeping (lastAccrueAt,
// lastState) is persisted so accrual survives service-worker restarts, and a
// 30-second alarm keeps time flowing during long calls/chats with no DOM churn.
// ---------------------------------------------------------------------------

// tabId -> { state, at } (in-memory; rebuilt from live heartbeats)
const presenceByTab = new Map();
const TAB_STALE_MS = 60000;

function get(key) {
  return new Promise((r) => chrome.storage.local.get(key, (res) => r(res[key])));
}
function set(obj) {
  return new Promise((r) => chrome.storage.local.set(obj, r));
}

let presenceQueue = Promise.resolve();
function queuePresence(fn) {
  presenceQueue = presenceQueue.then(fn).catch((e) =>
    logLine("error", "presence step failed", String(e))
  );
  return presenceQueue;
}

async function logLine(level, msg, detail) {
  const logs = (await get(LOGS_KEY)) || [];
  await set({ [LOGS_KEY]: appendLog(logs, { ts: Date.now(), level, msg, detail }) });
}

function mergedNow() {
  const now = Date.now();
  const states = [];
  for (const [tabId, p] of presenceByTab) {
    if (now - p.at > TAB_STALE_MS) presenceByTab.delete(tabId);
    else states.push(p.state);
  }
  return mergePresence(states);
}

// Accrue time for the state that was active since the last accrual, then record
// the new merged state. Called on every heartbeat and on the alarm tick.
async function accrueAndUpdate(logChange) {
  const now = Date.now();
  const merged = mergedNow(); // also prunes stale tabs
  const pres = (await get(PRESENCE_KEY)) || {};
  const prevState = pres.state || "idle";

  // Nothing to track and nothing to report — skip to avoid idle storage churn
  // from the 30s heartbeat alarm when no Zendesk tab is open.
  if (presenceByTab.size === 0 && prevState === "idle" && merged === "idle") return;

  const lastAt = pres.lastAccrueAt || now;
  const deltaSec = Math.min(ACCRUE_CAP_SEC, Math.max(0, Math.round((now - lastAt) / 1000)));
  const kind = presenceKind(prevState);
  if (kind && deltaSec > 0) {
    const away = normalizeAway((await get(AWAY_KEY)) || {});
    await set({ [AWAY_KEY]: addAway(away, localDateKey(new Date(now)), kind, deltaSec) });
  }

  const changed = merged !== prevState;
  await set({
    [PRESENCE_KEY]: {
      state: merged,
      since: changed ? now : pres.since || now,
      updatedAt: now,
      tabs: presenceByTab.size,
      lastAccrueAt: now,
    },
  });
  if (changed && logChange) {
    await logLine("info", `presence: ${prevState} -> ${merged}`, { tabs: presenceByTab.size });
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;
  if (msg.type === "refreshAction") {
    refreshAction();
    return;
  }
  if (msg.type === "pt-log") {
    queuePresence(() => logLine(msg.level || "info", msg.msg || "", msg.detail));
    return;
  }
  if (msg.type === "pt-presence") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId == null) return;
    presenceByTab.set(tabId, { state: msg.state || "idle", at: Date.now() });
    queuePresence(async () => {
      if (msg.changed && msg.signals) {
        await logLine("debug", `tab ${tabId}: ${msg.state}`, msg.signals);
      }
      await accrueAndUpdate(true);
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (presenceByTab.delete(tabId)) queuePresence(() => accrueAndUpdate(true));
});

// Heartbeat so time keeps accruing during a long call/chat without DOM changes,
// and so stale tabs get pruned even if their content script died silently.
chrome.alarms.create("pt-tick", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "pt-tick") queuePresence(() => accrueAndUpdate(true));
});
