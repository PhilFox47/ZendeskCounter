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
} from "./detect.js";
import { makeIcons } from "./icon.js";

const STORAGE_KEY = "counterState";

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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "refreshAction") refreshAction();
});
