// Service worker: observes Zendesk Agent Workspace ticket-submit requests,
// counts public replies and solved submits, and reflects them on the badge.
//
// Detection is confirmed against captured HAR payloads:
//   POST /api/graphql, operationName "UpdateTicketMutation"
//     variables.ticket.comment.isPublic === true  -> public reply
//     variables.ticket.status === "SOLVED"         -> solved
// We read the request body via chrome.webRequest and only count a submit that
// completes with an HTTP 200, so failed/cancelled submits don't inflate counts.

import {
  deltaFromRequestBody,
  applyDelta,
  rollover,
  badgeValue,
  localDateKey,
} from "./detect.js";

const STORAGE_KEY = "counterState";
const BADGE_BG = "#2f7a3e"; // green

// requestId -> pending delta captured in onBeforeRequest, consumed in onCompleted.
const pending = new Map();

// Serialize storage read-modify-write so rapid submits don't race.
let writeChain = Promise.resolve();

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => {
      resolve(rollover(res[STORAGE_KEY]));
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

async function updateBadge(state) {
  const value = badgeValue(state);
  const text = value > 0 ? String(value) : "";
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  const t = state.today || { replies: 0, solved: 0 };
  await chrome.action.setTitle({
    title: `Zendesk today — Replies: ${t.replies} · Solved: ${t.solved}`,
  });
}

function commitDelta(delta) {
  writeChain = writeChain.then(async () => {
    const state = await getState();
    const next = applyDelta(state, delta, localDateKey());
    await setState(next);
    await updateBadge(next);
  });
  return writeChain;
}

// 1) Capture the request body as the submit goes out.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.method !== "POST") return;
    const body = decodeRequestBody(details.requestBody);
    const delta = deltaFromRequestBody(body);
    if (delta.replies > 0 || delta.solved > 0) {
      pending.set(details.requestId, delta);
    }
  },
  { urls: ["*://*.zendesk.com/api/graphql*"] },
  ["requestBody"]
);

// 2) Only count once the submit actually succeeds.
chrome.webRequest.onCompleted.addListener(
  (details) => {
    const delta = pending.get(details.requestId);
    if (!delta) return;
    pending.delete(details.requestId);
    if (details.statusCode >= 200 && details.statusCode < 300) {
      commitDelta(delta);
    }
  },
  { urls: ["*://*.zendesk.com/api/graphql*"] }
);

// 3) Clean up on failure so the map doesn't leak.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    pending.delete(details.requestId);
  },
  { urls: ["*://*.zendesk.com/api/graphql*"] }
);

// Keep the badge correct across service-worker restarts, midnight rollover, and
// changes made from the popup (metric switch / reset).
async function refreshBadge() {
  const state = await getState();
  await setState(state); // persists any rollover reset
  await updateBadge(state);
}

chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORAGE_KEY]) {
    updateBadge(rollover(changes[STORAGE_KEY].newValue));
  }
});

// Handle explicit refresh requests from the popup.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "refreshBadge") refreshBadge();
});
