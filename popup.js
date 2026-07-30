import {
  normalize,
  metricsForDate,
  sortedDays,
  localDateKey,
  formatRate,
  slotStatus,
  serializeState,
  parseImport,
  mergeStates,
  awayForDate,
  formatLogsForExport,
  DEFAULT_GOALS,
} from "./detect.js";

const STORAGE_KEY = "counterState";
const AWAY_KEY = "awayTime";
const PRESENCE_KEY = "presenceState";
const LOGS_KEY = "ptLogs";

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

  renderSlot(s);
}

// "Act now?" indicator — recomputed on open, on a timer, and on data changes.
function renderSlot(s) {
  const slot = slotStatus(s, new Date());
  const box = document.getElementById("slotNow");
  const title = document.getElementById("slotTitle");
  const sub = document.getElementById("slotSub");
  box.classList.remove("go", "wait", "active");
  box.classList.add(slot.status);
  const blockWindow = `${slot.blockStart}–${slot.blockEnd}`;
  if (slot.status === "active") {
    title.textContent = "Productive slot active";
    sub.textContent = `You've logged activity in this block (${blockWindow}). Keep going — it's already counted.`;
  } else if (slot.status === "go") {
    title.textContent = "Good time to start";
    sub.textContent = `This block (${blockWindow}) is still open — a ticket now books it with ~${slot.minsLeftCeil} min to work.`;
  } else {
    title.textContent = `Maybe wait ~${slot.minsLeftCeil} min`;
    sub.textContent = `Only ${slot.minsLeftCeil} min left in this block. Waiting for ${slot.blockEnd} books a fresh 30-min slot instead of this near-empty one.`;
  }
}

function fmtDuration(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Live presence indicator (auto-detected chat / call).
async function renderPresence() {
  const [pres, away] = await Promise.all([
    new Promise((r) => chrome.storage.local.get(PRESENCE_KEY, (o) => r(o[PRESENCE_KEY]))),
    new Promise((r) => chrome.storage.local.get(AWAY_KEY, (o) => r(o[AWAY_KEY]))),
  ]);
  const box = document.getElementById("presenceBox");
  const title = document.getElementById("prTitle");
  const sub = document.getElementById("prSub");
  const a = awayForDate(away, localDateKey());
  const awayLine = `Today: ${a.chatMin}m chat · ${a.callMin}m call`;

  box.classList.remove("idle", "chat", "call", "stale");
  if (!pres || pres.updatedAt == null) {
    box.classList.add("stale");
    title.textContent = "Presence: not detected";
    sub.textContent = "Open a Zendesk agent tab to start detecting. " + awayLine;
    return;
  }
  const staleMs = Date.now() - pres.updatedAt;
  const state = staleMs > 90000 ? "stale" : pres.state || "idle";
  if (state === "stale") {
    box.classList.add("stale");
    title.textContent = "Presence: idle (no active Zendesk tab)";
    sub.textContent = awayLine;
    return;
  }
  box.classList.add(state);
  const sinceSec = Math.max(0, Math.round((Date.now() - (pres.since || Date.now())) / 1000));
  if (state === "call") {
    title.textContent = "On a call";
    sub.textContent = `for ${fmtDuration(sinceSec)} · ${awayLine}`;
  } else if (state === "chat") {
    title.textContent = "In an active chat";
    sub.textContent = `for ${fmtDuration(sinceSec)} · ${awayLine}`;
  } else {
    title.textContent = "Working tickets (no chat/call)";
    sub.textContent = awayLine;
  }
}

async function init() {
  let state = await getState();
  render(state);
  renderPresence();

  // Keep the "act now?" indicator and presence live while the popup is open.
  setInterval(() => {
    renderSlot(state);
    renderPresence();
  }, 5000);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) {
      state = normalize(changes[STORAGE_KEY].newValue);
      render(state);
    }
    if (changes[PRESENCE_KEY] || changes[AWAY_KEY]) renderPresence();
  });

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

  document.getElementById("openDashboard").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    window.close();
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

  // --- Diagnostics: export / clear presence logs ----------------------------
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.getElementById("exportLogs").addEventListener("click", async () => {
    const [logs, away] = await Promise.all([
      new Promise((r) => chrome.storage.local.get(LOGS_KEY, (o) => r(o[LOGS_KEY] || []))),
      new Promise((r) => chrome.storage.local.get(AWAY_KEY, (o) => r(o[AWAY_KEY]))),
    ]);
    const text = formatLogsForExport(logs, {
      version: chrome.runtime.getManifest().version,
      away: awayForDate(away, localDateKey()),
    });
    download(`ticket-telemetry-logs-${localDateKey()}.txt`, text, "text/plain");
  });

  document.getElementById("clearLogs").addEventListener("click", async () => {
    if (!confirm("Clear the presence detection logs?")) return;
    await new Promise((r) => chrome.storage.local.set({ [LOGS_KEY]: [] }, r));
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
