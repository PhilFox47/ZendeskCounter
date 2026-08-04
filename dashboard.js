import {
  normalize,
  sortedDays,
  metricsForDate,
  blockSeries,
  blockLabel,
  formatRate,
  progressColor,
  isBonusRate,
  localDateKey,
  BLOCKS_PER_DAY,
  weekAggregate,
  sortedWeeks,
  mondayOf,
  addDaysKey,
  awayForDate,
} from "./detect.js";

const STORAGE_KEY = "counterState";
const AWAY_KEY = "awayTime";

function getState() {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (res) => resolve(normalize(res[STORAGE_KEY])));
  });
}

const fmtHours = (n) => (Math.round(n * 10) / 10).toString();

function prettyDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
}
function shortDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return {
    main: dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
    year: dt.getFullYear(),
    monthDay: dt.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
  };
}
function weekRangeLabel(monday) {
  const friday = addDaysKey(monday, 4);
  const [my, mm, md] = monday.split("-").map(Number);
  const [fy, fm, fd] = friday.split("-").map(Number);
  const mo = (mth, day) => new Date(2000, mth - 1, day).toLocaleDateString(undefined, { month: "short" });
  return mm === fm
    ? `${mo(mm, md)} ${md} – ${fd}, ${fy}`
    : `${mo(mm, md)} ${md} – ${mo(fm, fd)} ${fd}, ${fy}`;
}

// A day is "legacy" (pre block-level tracking) when it has active blocks but no
// per-block detail at all.
function isLegacy(day) {
  return day.blocks.length > 0 && Object.keys(day.blockStats).length === 0;
}

let state = null;
let goals = null;
let away = {}; // { "YYYY-MM-DD": { chatSec, callSec } }
let mode = "day"; // "day" | "week"
let selectedDate = null;
let selectedWeek = null;
let dayList = []; // newest-first date keys
let weekList = []; // newest-first Monday keys

function getAway() {
  return new Promise((r) => chrome.storage.local.get(AWAY_KEY, (o) => r(o[AWAY_KEY] || {})));
}
function fmtAway(min) {
  return `${min}m`;
}

// --- Shared rendering --------------------------------------------------------

// Returns null (empty), "legacy", "rainbow" (bonus tier > 250%), or a hex color.
function cellColorFor(cell, metric, goal, legacy) {
  if (!cell.active) return null;
  if (legacy) return "legacy";
  const rate = metric === "solved" ? cell.solvedPerHour : cell.repliesPerHour;
  if (isBonusRate(rate, goal)) return "rainbow";
  return progressColor(rate, goal);
}

function renderTrack(el, series, metric, goal, legacy, { mini } = {}) {
  el.innerHTML = "";
  for (const cell of series) {
    const div = document.createElement("div");
    const color = cellColorFor(cell, metric, goal, legacy);
    const isClass = color === "legacy" || color === "rainbow";
    if (mini) {
      div.className = "mini-cell" + (isClass ? " " + color : "");
      if (color && !isClass) div.style.background = color;
    } else {
      div.className = "cell";
      const count = metric === "solved" ? cell.solved : cell.replies;
      const rate = metric === "solved" ? cell.solvedPerHour : cell.repliesPerHour;
      if (!cell.active) {
        div.classList.add("empty");
      } else if (color === "legacy") {
        div.classList.add("legacy");
        div.title = `${cell.label} — active (no per-block detail)`;
      } else {
        if (color === "rainbow") div.classList.add("rainbow");
        else div.style.background = color;
        div.textContent = count > 0 ? String(count) : "";
        const blockWindow = `${cell.label}–${blockLabel((cell.index + 1) % BLOCKS_PER_DAY)}`;
        div.title =
          `${blockWindow} · ${count} ${metric} (${formatRate(rate)}/hr)` +
          (color === "rainbow" ? " ✨ bonus split!" : "");
      }
    }
    el.appendChild(div);
  }
}

function legendHTML() {
  return `<span>0%</span><div class="bar"></div><span>150%+</span><span style="margin-left:6px">of target</span>`;
}

function card(k, v, sub, color) {
  return (
    `<div class="scard"><div class="k">${k}</div>` +
    `<div class="v"${color ? ` style="color:${color}"` : ""}>${v}</div>` +
    `<div class="sub">${sub}</div></div>`
  );
}

function rateChips(m) {
  const sc = progressColor(m.solvedPerHour, goals.solvedPerHour);
  const rc = progressColor(m.repliesPerHour, goals.repliesPerHour);
  return (
    `<div>S <b style="color:${sc}">${formatRate(m.solvedPerHour)}</b>/hr</div>` +
    `<div>R <b style="color:${rc}">${formatRate(m.repliesPerHour)}</b>/hr</div>`
  );
}

// --- Day view ----------------------------------------------------------------

function peakRate(day, metric) {
  const series = blockSeries(day);
  let best = null;
  for (const c of series) {
    const rate = metric === "solved" ? c.solvedPerHour : c.repliesPerHour;
    if (rate > 0 && (!best || rate > best.rate)) best = { rate };
  }
  return best ? `${formatRate(best.rate)}/hr` : "—";
}

function renderAxis() {
  const axis = document.getElementById("axis");
  axis.innerHTML = "";
  for (let h = 0; h < 24; h++) {
    const s = document.createElement("span");
    s.textContent = h % 2 === 0 ? String(h).padStart(2, "0") : "";
    axis.appendChild(s);
  }
}

function renderDay() {
  const day = state.days[selectedDate];
  const m = metricsForDate(state, selectedDate, away);
  const legacy = isLegacy(day);
  const series = blockSeries(day);

  const solvedColor = progressColor(m.solvedPerHour, goals.solvedPerHour);
  const repliesColor = progressColor(m.repliesPerHour, goals.repliesPerHour);
  const a = awayForDate(away, selectedDate);
  const dedMin = Math.round((m.deductedSec || 0) / 60);
  const repliesSub =
    `${m.replies} replies · target ${goals.repliesPerHour}` +
    (dedMin > 0 ? ` · −${dedMin}m chat/call` : "");
  document.getElementById("summary").innerHTML =
    card("Productive time", `${fmtHours(m.productiveHours)}h`, `${m.productiveBlocks} active blocks`) +
    card("Solved / hr", formatRate(m.solvedPerHour), `${m.solved} solved · target ${goals.solvedPerHour}`, solvedColor) +
    card("Replies / hr", formatRate(m.repliesPerHour), repliesSub, repliesColor) +
    card("Peak solve rate", peakRate(day, "solved"), "best 30-min block") +
    card("Chat / call", `${fmtAway(a.chatMin)} / ${fmtAway(a.callMin)}`, `${fmtAway(a.totalMin)} away from tickets`);

  document.getElementById("legend").innerHTML = legendHTML();
  document.getElementById("solvedTgt").textContent = `target ${goals.solvedPerHour}/hr`;
  document.getElementById("repliesTgt").textContent = `target ${goals.repliesPerHour}/hr`;
  renderTrack(document.getElementById("trackSolved"), series, "solved", goals.solvedPerHour, legacy);
  renderTrack(document.getElementById("trackReplies"), series, "replies", goals.repliesPerHour, legacy);
  renderAxis();
  document.getElementById("legacyNote").hidden = !legacy;

  const el = document.getElementById("recentList");
  el.innerHTML = "";
  for (const date of dayList.slice(0, 14)) {
    const d = state.days[date];
    const dm = metricsForDate(state, date, away);
    const sd = shortDate(date);
    const row = document.createElement("div");
    row.className = "recent-day" + (date === selectedDate ? " active" : "");
    row.addEventListener("click", () => selectPeriod(date));
    const tracks = document.createElement("div");
    tracks.className = "recent-tracks";
    const t1 = document.createElement("div"); t1.className = "mini-track";
    const t2 = document.createElement("div"); t2.className = "mini-track";
    renderTrack(t1, blockSeries(d), "solved", goals.solvedPerHour, isLegacy(d), { mini: true });
    renderTrack(t2, blockSeries(d), "replies", goals.repliesPerHour, isLegacy(d), { mini: true });
    tracks.append(t1, t2);
    row.innerHTML = `<div class="rd-date">${sd.main}<small>${sd.year} · ${fmtHours(dm.productiveHours)}h</small></div>`;
    row.appendChild(tracks);
    const rates = document.createElement("div");
    rates.className = "rd-rates";
    rates.innerHTML = rateChips(dm);
    row.appendChild(rates);
    el.appendChild(row);
  }
}

// --- Week view ---------------------------------------------------------------

function weekStrip(container, week, metric) {
  container.innerHTML = "";
  const goal = metric === "solved" ? goals.solvedPerHour : goals.repliesPerHour;
  for (const d of week.days) {
    const cell = document.createElement("div");
    cell.className = "wk-cell";
    const rate = metric === "solved" ? d.metrics.solvedPerHour : d.metrics.repliesPerHour;
    if (d.metrics.productiveBlocks === 0) {
      cell.classList.add("empty");
    } else if (isBonusRate(rate, goal)) {
      cell.classList.add("rainbow");
    } else {
      cell.style.background = progressColor(rate, goal);
    }
    cell.title = `${d.weekday}: ${metric === "solved" ? d.metrics.solved : d.metrics.replies} ${metric} (${formatRate(rate)}/hr)`;
    container.appendChild(cell);
  }
}

function renderWeek() {
  if (!selectedWeek) {
    document.getElementById("weekSummary").innerHTML =
      `<div class="scard" style="grid-column:1/-1"><div class="k">No weekday activity yet</div>` +
      `<div class="sub">Monday–Friday reports appear once you've handled tickets on a weekday.</div></div>`;
    document.getElementById("weekRange").textContent = "—";
    document.getElementById("weekDays").innerHTML = "";
    document.getElementById("recentWeeks").innerHTML = "";
    document.getElementById("weekLegend").innerHTML = "";
    return;
  }

  const week = weekAggregate(state, selectedWeek, away);
  document.getElementById("weekRange").textContent = weekRangeLabel(selectedWeek);
  document.getElementById("weekLegend").innerHTML = legendHTML();

  const solvedColor = progressColor(week.solvedPerHour, goals.solvedPerHour);
  const repliesColor = progressColor(week.repliesPerHour, goals.repliesPerHour);
  // Sum chat/call across the week's weekdays.
  let wkChat = 0;
  let wkCall = 0;
  for (const d of week.days) {
    const da = awayForDate(away, d.date);
    wkChat += da.chatSec;
    wkCall += da.callSec;
  }
  const wkChatMin = Math.round(wkChat / 60);
  const wkCallMin = Math.round(wkCall / 60);
  const wkDedMin = Math.round(Math.max(0, (week.productiveHours - week.replyProductiveHours)) * 60);
  const wkRepliesSub =
    `${week.replies} replies · target ${goals.repliesPerHour}` +
    (wkDedMin > 0 ? ` · −${wkDedMin}m chat/call` : "");
  document.getElementById("weekSummary").innerHTML =
    card("Productive time", `${fmtHours(week.productiveHours)}h`, `${week.productiveBlocks} active blocks`) +
    card("Solved / hr", formatRate(week.solvedPerHour), `${week.solved} solved · target ${goals.solvedPerHour}`, solvedColor) +
    card("Replies / hr", formatRate(week.repliesPerHour), wkRepliesSub, repliesColor) +
    card("Days worked", `${week.worked}/5`, "weekdays with activity") +
    card("Chat / call", `${fmtAway(wkChatMin)} / ${fmtAway(wkCallMin)}`, `${fmtAway(wkChatMin + wkCallMin)} away this week`);

  // Mon–Fri breakdown rows
  const wd = document.getElementById("weekDays");
  wd.innerHTML = "";
  for (const d of week.days) {
    const sd = shortDate(d.date);
    const worked = d.metrics.productiveBlocks > 0;
    const row = document.createElement("div");
    row.className = "recent-day week-day" + (d.date === selectedDate ? " active" : "");
    row.addEventListener("click", () => { switchMode("day"); selectPeriod(d.date); });

    const da = awayForDate(away, d.date);
    const awayNote = da.totalSec > 0 ? ` · ${fmtAway(da.totalMin)} chat/call` : "";
    row.innerHTML = `<div class="rd-date">${d.weekday}<small>${sd.monthDay}${worked ? " · " + fmtHours(d.metrics.productiveHours) + "h" : ""}${awayNote}</small></div>`;
    const tracks = document.createElement("div");
    tracks.className = "recent-tracks";
    const t1 = document.createElement("div"); t1.className = "mini-track";
    const t2 = document.createElement("div"); t2.className = "mini-track";
    renderTrack(t1, blockSeries(d.day), "solved", goals.solvedPerHour, isLegacy(d.day), { mini: true });
    renderTrack(t2, blockSeries(d.day), "replies", goals.repliesPerHour, isLegacy(d.day), { mini: true });
    tracks.append(t1, t2);
    row.appendChild(tracks);
    const rates = document.createElement("div");
    rates.className = "rd-rates";
    rates.innerHTML = worked ? rateChips(d.metrics) : `<div class="rest">rest day</div>`;
    row.appendChild(rates);
    wd.appendChild(row);
  }

  // Recent weeks
  const rw = document.getElementById("recentWeeks");
  rw.innerHTML = "";
  for (const monday of weekList.slice(0, 10)) {
    const w = weekAggregate(state, monday, away);
    const row = document.createElement("div");
    row.className = "recent-day" + (monday === selectedWeek ? " active" : "");
    row.addEventListener("click", () => selectPeriod(monday));
    row.innerHTML = `<div class="rd-date">${weekRangeLabel(monday)}<small>${w.worked}/5 days · ${fmtHours(w.productiveHours)}h</small></div>`;
    const strips = document.createElement("div");
    strips.className = "recent-tracks";
    const s1 = document.createElement("div"); s1.className = "wk-strip";
    const s2 = document.createElement("div"); s2.className = "wk-strip";
    weekStrip(s1, w, "solved");
    weekStrip(s2, w, "replies");
    strips.append(s1, s2);
    row.appendChild(strips);
    const rates = document.createElement("div");
    rates.className = "rd-rates";
    rates.innerHTML = rateChips(w);
    row.appendChild(rates);
    rw.appendChild(row);
  }
}

// --- Mode + navigation -------------------------------------------------------

function populateSelect() {
  const sel = document.getElementById("periodSelect");
  sel.innerHTML = "";
  const list = mode === "day" ? dayList : weekList;
  for (const key of list) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = mode === "day" ? prettyDate(key) : weekRangeLabel(key);
    sel.appendChild(opt);
  }
  sel.value = mode === "day" ? selectedDate : selectedWeek;
}

function render() {
  if (mode === "day") renderDay();
  else renderWeek();
}

function selectPeriod(key) {
  if (mode === "day") selectedDate = key;
  else selectedWeek = key;
  document.getElementById("periodSelect").value = key;
  render();
}

function stepPeriod(delta) {
  const list = mode === "day" ? dayList : weekList;
  const cur = mode === "day" ? selectedDate : selectedWeek;
  const j = list.indexOf(cur) + delta;
  if (j >= 0 && j < list.length) selectPeriod(list[j]);
}

function switchMode(m) {
  if (m === mode) return;
  mode = m;
  for (const b of document.querySelectorAll("#modes .mode")) {
    b.classList.toggle("active", b.dataset.mode === m);
  }
  document.getElementById("dayView").hidden = m !== "day";
  document.getElementById("weekView").hidden = m !== "week";
  populateSelect();
  render();
}

function recomputeLists() {
  dayList = sortedDays(state).map((d) => d.date);
  weekList = sortedWeeks(state);
  const today = localDateKey();
  if (!selectedDate || !dayList.includes(selectedDate)) {
    selectedDate = dayList.includes(today) ? today : dayList[0] || null;
  }
  const thisWeek = mondayOf(today);
  if (!selectedWeek || !weekList.includes(selectedWeek)) {
    selectedWeek = weekList.includes(thisWeek) ? thisWeek : weekList[0] || null;
  }
}

async function init() {
  state = await getState();
  goals = state.goals;
  away = await getAway();
  recomputeLists();

  if (dayList.length === 0) {
    document.getElementById("main").hidden = true;
    document.getElementById("empty").hidden = false;
    return;
  }

  populateSelect();
  render();

  document.getElementById("periodSelect").addEventListener("change", (e) => selectPeriod(e.target.value));
  document.getElementById("prevPeriod").addEventListener("click", () => stepPeriod(1)); // ◀ earlier = higher index
  document.getElementById("nextPeriod").addEventListener("click", () => stepPeriod(-1));
  for (const b of document.querySelectorAll("#modes .mode")) {
    b.addEventListener("click", () => switchMode(b.dataset.mode));
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[AWAY_KEY]) away = changes[AWAY_KEY].newValue || {};
    if (changes[STORAGE_KEY]) {
      state = normalize(changes[STORAGE_KEY].newValue);
      goals = state.goals;
      recomputeLists();
    }
    if (dayList.length === 0) return;
    if (changes[STORAGE_KEY] || changes[AWAY_KEY]) {
      populateSelect();
      render();
    }
  });
}

init();
