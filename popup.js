import {
  normalize,
  metricsForDate,
  sortedDays,
  localDateKey,
  DEFAULT_GOALS,
} from "./detect.js";

const STORAGE_KEY = "counterState";

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => resolve(normalize(res[STORAGE_KEY])));
  });
}

function setState(state) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: state }, resolve);
  });
}

const fmt1 = (n) => (Math.round(n * 10) / 10).toString();

function shortDate(key) {
  // key is YYYY-MM-DD; render as e.g. "Mon 14 Jul"
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function applyRate(prefix, value, goal) {
  const el = document.getElementById("rate" + prefix[0].toUpperCase() + prefix.slice(1));
  const valEl = document.getElementById(prefix + "PerHour");
  const barEl = document.getElementById(prefix + "Bar");
  valEl.textContent = fmt1(value);
  const pct = goal > 0 ? Math.min(100, (value / goal) * 100) : value > 0 ? 100 : 0;
  barEl.style.width = pct + "%";
  const met = value >= goal && goal > 0;
  el.classList.toggle("good", met);
  el.classList.toggle("bad", !met);
}

function render(state) {
  const s = normalize(state);
  const goals = s.goals || DEFAULT_GOALS;
  const today = metricsForDate(s);

  document.getElementById("prodHours").textContent = fmt1(today.productiveHours);
  document.getElementById("prodBlocks").textContent = today.productiveBlocks;
  document.getElementById("todayReplies").textContent = today.replies;
  document.getElementById("todaySolved").textContent = today.solved;

  document.getElementById("goalReplies").textContent = `target ${goals.repliesPerHour}`;
  document.getElementById("goalSolved").textContent = `target ${goals.solvedPerHour}`;
  applyRate("replies", today.repliesPerHour, goals.repliesPerHour);
  applyRate("solved", today.solvedPerHour, goals.solvedPerHour);

  document.getElementById("badgeMetric").value = s.badgeMetric;
  document.getElementById("goalRepliesInput").value = goals.repliesPerHour;
  document.getElementById("goalSolvedInput").value = goals.solvedPerHour;

  // History table
  const rows = sortedDays(s);
  const body = document.getElementById("historyBody");
  const empty = document.getElementById("historyEmpty");
  body.innerHTML = "";
  if (rows.length === 0) {
    empty.style.display = "block";
  } else {
    empty.style.display = "none";
    const todayKey = localDateKey();
    for (const r of rows.slice(0, 21)) {
      const tr = document.createElement("tr");
      if (r.date === todayKey) tr.className = "today";
      const rHit = r.repliesPerHour >= goals.repliesPerHour && r.productiveHours > 0;
      const sHit = r.solvedPerHour >= goals.solvedPerHour && r.productiveHours > 0;
      tr.innerHTML =
        `<td>${shortDate(r.date)}</td>` +
        `<td>${fmt1(r.productiveHours)}h</td>` +
        `<td>${r.replies}</td>` +
        `<td class="${rHit ? "hit" : "miss"}">${fmt1(r.repliesPerHour)}</td>` +
        `<td>${r.solved}</td>` +
        `<td class="${sHit ? "hit" : "miss"}">${fmt1(r.solvedPerHour)}</td>`;
      body.appendChild(tr);
    }
  }
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

  async function updateGoal(field, value) {
    state = await getState();
    const n = Math.max(0, Math.floor(Number(value) || 0));
    state.goals = { ...state.goals, [field]: n };
    await setState(state);
    render(state);
    chrome.runtime.sendMessage({ type: "refreshBadge" });
  }
  document
    .getElementById("goalRepliesInput")
    .addEventListener("change", (e) => updateGoal("repliesPerHour", e.target.value));
  document
    .getElementById("goalSolvedInput")
    .addEventListener("change", (e) => updateGoal("solvedPerHour", e.target.value));

  document.getElementById("resetAll").addEventListener("click", async () => {
    if (!confirm("Reset ALL productivity data (every day)? This cannot be undone.")) {
      return;
    }
    state = await getState();
    state.days = {};
    await setState(state);
    render(state);
    chrome.runtime.sendMessage({ type: "refreshBadge" });
  });
}

init();
