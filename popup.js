import {
  normalize,
  metricsForDate,
  sortedDays,
  localDateKey,
  formatRate,
  serializeState,
  parseImport,
  mergeStates,
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

const fmt1 = (n) => (Math.round(n * 10) / 10).toString(); // hours (e.g. "2", "2.5")

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
  valEl.textContent = formatRate(value);
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
        `<td class="${rHit ? "hit" : "miss"}">${formatRate(r.repliesPerHour)}</td>` +
        `<td>${r.solved}</td>` +
        `<td class="${sHit ? "hit" : "miss"}">${formatRate(r.solvedPerHour)}</td>`;
      body.appendChild(tr);
    }
  }
}

async function init() {
  let state = await getState();
  render(state);

  async function updateGoal(field, value) {
    state = await getState();
    const n = Math.max(0, Math.floor(Number(value) || 0));
    state.goals = { ...state.goals, [field]: n };
    await setState(state);
    render(state);
    chrome.runtime.sendMessage({ type: "refreshAction" });
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
    chrome.runtime.sendMessage({ type: "refreshAction" });
  });

  // --- Export ---------------------------------------------------------------
  document.getElementById("exportBtn").addEventListener("click", async () => {
    const s = await getState();
    const json = JSON.stringify(serializeState(s), null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zendesk-productivity-${localDateKey()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // --- Import (merge or replace) --------------------------------------------
  const importFile = document.getElementById("importFile");
  let importMode = "merge";
  document.getElementById("importMergeBtn").addEventListener("click", () => {
    importMode = "merge";
    importFile.click();
  });
  document.getElementById("importReplaceBtn").addEventListener("click", () => {
    importMode = "replace";
    importFile.click();
  });

  importFile.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    let text;
    try {
      text = await file.text();
    } catch {
      alert("Could not read that file.");
      return;
    }
    const res = parseImport(text);
    if (!res.ok) {
      alert("Import failed: " + res.error);
      return;
    }

    state = await getState();
    let next;
    if (importMode === "replace") {
      if (
        !confirm(
          `Replace ALL current data with ${res.dayCount} day(s) from the file? ` +
            `This overwrites what you have now.`
        )
      ) {
        return;
      }
      next = res.state;
    } else {
      if (
        !confirm(
          `Merge ${res.dayCount} day(s) into your data? For overlapping days the ` +
            `higher counts are kept and productive blocks are combined; your current ` +
            `targets are unchanged.`
        )
      ) {
        return;
      }
      next = mergeStates(state, res.state);
    }

    state = next;
    await setState(state);
    render(state);
    chrome.runtime.sendMessage({ type: "refreshAction" });
    alert("Import complete.");
  });
}

init();
