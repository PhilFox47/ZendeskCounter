import {
  normalize,
  sortedDays,
  metricsForDate,
  blockSeries,
  blockLabel,
  formatRate,
  progressColor,
  localDateKey,
  BLOCKS_PER_DAY,
} from "./detect.js";

const STORAGE_KEY = "counterState";

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => resolve(normalize(res[STORAGE_KEY])));
  });
}

const fmtHours = (n) => (Math.round(n * 10) / 10).toString();

function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
function shortDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return {
    main: dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
    year: dt.getFullYear(),
  };
}

// A day is "legacy" (pre block-level tracking) when it has active blocks but no
// per-block detail at all.
function isLegacy(day) {
  return day.blocks.length > 0 && Object.keys(day.blockStats).length === 0;
}

let state = null;
let goals = null;
let selectedDate = null;
let dayList = []; // newest-first date keys

function cellColorFor(cell, metric, goal, legacy) {
  if (!cell.active) return null;
  if (legacy) return "legacy";
  const rate = metric === "solved" ? cell.solvedPerHour : cell.repliesPerHour;
  return progressColor(rate, goal);
}

function renderTrack(el, series, metric, goal, legacy, { mini } = {}) {
  el.innerHTML = "";
  for (const cell of series) {
    const div = document.createElement("div");
    const color = cellColorFor(cell, metric, goal, legacy);
    if (mini) {
      div.className = "mini-cell" + (color === "legacy" ? " legacy" : "");
      if (color && color !== "legacy") div.style.background = color;
    } else {
      div.className = "cell";
      const count = metric === "solved" ? cell.solved : cell.replies;
      if (!cell.active) {
        div.classList.add("empty");
      } else if (color === "legacy") {
        div.classList.add("legacy");
        div.title = `${cell.label} — active (no per-block detail)`;
      } else {
        div.style.background = color;
        div.textContent = count > 0 ? String(count) : "";
        const rate = metric === "solved" ? cell.solvedPerHour : cell.repliesPerHour;
        div.title =
          `${cell.label}–${blockLabel((cell.index + 1) % BLOCKS_PER_DAY)} · ` +
          `${count} ${metric} (${formatRate(rate)}/hr)`;
      }
    }
    el.appendChild(div);
  }
}

function renderAxis() {
  const axis = document.getElementById("axis");
  axis.innerHTML = "";
  // 24 columns, one label every 2 hours
  for (let h = 0; h < 24; h++) {
    const s = document.createElement("span");
    s.textContent = h % 2 === 0 ? String(h).padStart(2, "0") : "";
    axis.appendChild(s);
  }
}

function renderSummary(day, metrics) {
  const solvedColor = progressColor(metrics.solvedPerHour, goals.solvedPerHour);
  const repliesColor = progressColor(metrics.repliesPerHour, goals.repliesPerHour);
  const cards = [
    { k: "Productive time", v: `${fmtHours(metrics.productiveHours)}h`, sub: `${metrics.productiveBlocks} active blocks` },
    { k: "Solved / hr", v: formatRate(metrics.solvedPerHour), sub: `${metrics.solved} solved · target ${goals.solvedPerHour}`, color: solvedColor },
    { k: "Replies / hr", v: formatRate(metrics.repliesPerHour), sub: `${metrics.replies} replies · target ${goals.repliesPerHour}`, color: repliesColor },
    { k: "Peak solve rate", v: peakRate(day, "solved"), sub: "best 30-min block" },
  ];
  const el = document.getElementById("summary");
  el.innerHTML = "";
  for (const c of cards) {
    const div = document.createElement("div");
    div.className = "scard";
    div.innerHTML =
      `<div class="k">${c.k}</div>` +
      `<div class="v"${c.color ? ` style="color:${c.color}"` : ""}>${c.v}</div>` +
      `<div class="sub">${c.sub}</div>`;
    el.appendChild(div);
  }
}

function peakRate(day, metric) {
  const series = blockSeries(day);
  let best = null;
  for (const c of series) {
    const rate = metric === "solved" ? c.solvedPerHour : c.repliesPerHour;
    if (rate > 0 && (!best || rate > best.rate)) best = { rate, label: c.label };
  }
  return best ? `${formatRate(best.rate)}/hr` : "—";
}

function renderLegend() {
  const el = document.getElementById("legend");
  el.innerHTML =
    `<span>0%</span><div class="bar"></div><span>150%+</span>` +
    `<span style="margin-left:6px">of target</span>`;
}

function renderBoard() {
  const day = state.days[selectedDate];
  const metrics = metricsForDate(state, selectedDate);
  const legacy = isLegacy(day);
  const series = blockSeries(day);

  document.getElementById("solvedTgt").textContent = `target ${goals.solvedPerHour}/hr`;
  document.getElementById("repliesTgt").textContent = `target ${goals.repliesPerHour}/hr`;

  renderSummary(day, metrics);
  renderTrack(document.getElementById("trackSolved"), series, "solved", goals.solvedPerHour, legacy);
  renderTrack(document.getElementById("trackReplies"), series, "replies", goals.repliesPerHour, legacy);
  renderAxis();
  document.getElementById("legacyNote").hidden = !legacy;
}

function renderRecent() {
  const el = document.getElementById("recentList");
  el.innerHTML = "";
  for (const date of dayList.slice(0, 14)) {
    const day = state.days[date];
    const m = metricsForDate(state, date);
    const legacy = isLegacy(day);
    const series = blockSeries(day);
    const sd = shortDate(date);

    const row = document.createElement("div");
    row.className = "recent-day" + (date === selectedDate ? " active" : "");
    row.addEventListener("click", () => selectDay(date));

    const dateCol = document.createElement("div");
    dateCol.className = "rd-date";
    dateCol.innerHTML = `${sd.main}<small>${sd.year} · ${fmtHours(m.productiveHours)}h</small>`;

    const tracks = document.createElement("div");
    tracks.className = "recent-tracks";
    const t1 = document.createElement("div"); t1.className = "mini-track";
    const t2 = document.createElement("div"); t2.className = "mini-track";
    renderTrack(t1, series, "solved", goals.solvedPerHour, legacy, { mini: true });
    renderTrack(t2, series, "replies", goals.repliesPerHour, legacy, { mini: true });
    tracks.append(t1, t2);

    const rates = document.createElement("div");
    rates.className = "rd-rates";
    const sc = progressColor(m.solvedPerHour, goals.solvedPerHour);
    const rc = progressColor(m.repliesPerHour, goals.repliesPerHour);
    rates.innerHTML =
      `<div>S <b style="color:${sc}">${formatRate(m.solvedPerHour)}</b>/hr</div>` +
      `<div>R <b style="color:${rc}">${formatRate(m.repliesPerHour)}</b>/hr</div>`;

    row.append(dateCol, tracks, rates);
    el.appendChild(row);
  }
}

function populateSelect() {
  const sel = document.getElementById("daySelect");
  sel.innerHTML = "";
  for (const date of dayList) {
    const opt = document.createElement("option");
    opt.value = date;
    opt.textContent = prettyDate(date);
    sel.appendChild(opt);
  }
  sel.value = selectedDate;
}

function selectDay(date) {
  selectedDate = date;
  document.getElementById("daySelect").value = date;
  renderBoard();
  renderRecent();
}

function stepDay(delta) {
  const i = dayList.indexOf(selectedDate);
  const j = i + delta;
  if (j >= 0 && j < dayList.length) selectDay(dayList[j]);
}

async function init() {
  state = await getState();
  goals = state.goals;
  dayList = sortedDays(state).map((d) => d.date);

  if (dayList.length === 0) {
    document.getElementById("main").hidden = true;
    document.getElementById("empty").hidden = false;
    return;
  }

  const today = localDateKey();
  selectedDate = dayList.includes(today) ? today : dayList[0];

  populateSelect();
  renderLegend();
  renderBoard();
  renderRecent();

  document.getElementById("daySelect").addEventListener("change", (e) => selectDay(e.target.value));
  // Newer days are earlier in dayList, so "◀ earlier" moves to a higher index.
  document.getElementById("prevDay").addEventListener("click", () => stepDay(1));
  document.getElementById("nextDay").addEventListener("click", () => stepDay(-1));

  // Live-update if tracking changes while the tab is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[STORAGE_KEY]) return;
    state = normalize(changes[STORAGE_KEY].newValue);
    goals = state.goals;
    dayList = sortedDays(state).map((d) => d.date);
    if (!dayList.includes(selectedDate)) selectedDate = dayList[0] || null;
    if (selectedDate) {
      populateSelect();
      renderBoard();
      renderRecent();
    }
  });
}

init();
