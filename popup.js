import { rollover } from "./detect.js";

const STORAGE_KEY = "counterState";

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

function render(state) {
  document.getElementById("todayReplies").textContent = state.today.replies;
  document.getElementById("todaySolved").textContent = state.today.solved;
  document.getElementById("totalReplies").textContent = state.total.replies;
  document.getElementById("totalSolved").textContent = state.total.solved;
  document.getElementById("badgeMetric").value = state.badgeMetric;
}

async function init() {
  let state = await getState();
  render(state);

  document.getElementById("badgeMetric").addEventListener("change", async (e) => {
    state = await getState();
    state.badgeMetric = e.target.value;
    await setState(state);
    chrome.runtime.sendMessage({ type: "refreshBadge" });
  });

  document.getElementById("resetTotals").addEventListener("click", async () => {
    if (!confirm("Reset all-time totals to zero? Today's counts are also cleared.")) {
      return;
    }
    state = await getState();
    state.today = { replies: 0, solved: 0 };
    state.total = { replies: 0, solved: 0 };
    await setState(state);
    render(state);
    chrome.runtime.sendMessage({ type: "refreshBadge" });
  });
}

init();
