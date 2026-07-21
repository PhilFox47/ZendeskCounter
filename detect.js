// Pure, dependency-free detection + counting logic for the Zendesk productivity
// tracker. Kept separate from background.js so it can be unit-tested in Node
// against real captured GraphQL payloads (see test/detect.test.mjs).

export const UPDATE_TICKET_OPERATION = "UpdateTicketMutation";

// 48 half-hour blocks per day. A block is "productive" if any ticket submit
// happened in it. Targets are per productive hour.
export const BLOCKS_PER_DAY = 48;
export const DEFAULT_GOALS = { repliesPerHour: 7, solvedPerHour: 3 };

/**
 * Parse a GraphQL request body (string) into an array of operation objects.
 * Zendesk sends either a single operation object or an array of them.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseGraphQLBody(text) {
  if (!text) return [];
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  return Array.isArray(json) ? json : [json];
}

/**
 * Analyze a single UpdateTicketMutation `variables` object.
 * @param {object} variables
 * @returns {{isPublicReply: boolean, isSolved: boolean}}
 */
export function analyzeUpdateTicket(variables) {
  const ticket = variables && variables.ticket;
  if (!ticket) return { isPublicReply: false, isSolved: false };

  const comment = ticket.comment;
  const isPublicReply = !!(comment && comment.isPublic === true);
  const isSolved =
    typeof ticket.status === "string" && ticket.status.toUpperCase() === "SOLVED";

  return { isPublicReply, isSolved };
}

/**
 * Given a full GraphQL request body, return the counting delta.
 * `activity` is true when the body contains any ticket submit at all (internal
 * note, public reply, solve, or field change) — that is what marks a 30-minute
 * block productive.
 * @param {string} text
 * @returns {{replies: number, solved: number, activity: boolean}}
 */
export function deltaFromRequestBody(text) {
  const ops = parseGraphQLBody(text);
  let replies = 0;
  let solved = 0;
  let activity = false;
  for (const op of ops) {
    if (!op || op.operationName !== UPDATE_TICKET_OPERATION) continue;
    activity = true;
    const { isPublicReply, isSolved } = analyzeUpdateTicket(op.variables || {});
    if (isPublicReply) replies += 1;
    if (isSolved) solved += 1;
  }
  return { replies, solved, activity };
}

// --- Time helpers -------------------------------------------------------------

/** Local calendar date string (YYYY-MM-DD). */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Index (0..47) of the 30-minute block a local time falls in. */
export function blockIndex(date = new Date()) {
  return date.getHours() * 2 + (date.getMinutes() >= 30 ? 1 : 0);
}

/** Human label for a block index, e.g. 22 -> "11:00". */
export function blockLabel(index) {
  const h = Math.floor(index / 2);
  const m = index % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
}

// --- State --------------------------------------------------------------------
//
// State shape:
// {
//   days: { "YYYY-MM-DD": { replies, solved, blocks: [sorted unique 0..47] } },
//   goals: { repliesPerHour, solvedPerHour }
// }

export function emptyDay() {
  // `blocks` is the set of active 30-min block indices (kept for metrics);
  // `blockStats` adds per-block reply/solve counts for the timeline view.
  return { replies: 0, solved: 0, blocks: [], blockStats: {} };
}

// Coerce a raw blockStats map to { "<idx>": { replies, solved } } with valid
// indices and non-negative integer counts.
function cleanBlockStats(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= BLOCKS_PER_DAY) continue;
    if (!v || typeof v !== "object") continue;
    out[idx] = {
      replies: Math.max(0, Math.floor(Number(v.replies) || 0)),
      solved: Math.max(0, Math.floor(Number(v.solved) || 0)),
    };
  }
  return out;
}

/**
 * Normalize (and migrate) a possibly-missing/partial/legacy stored state into
 * the current full shape. The legacy single-day shape ({date, today, total}) is
 * migrated by seeding that date's counts.
 * @param {object|undefined} state
 * @returns {object}
 */
export function normalize(state) {
  const base = {
    days: {},
    goals: { ...DEFAULT_GOALS },
  };
  if (!state || typeof state !== "object") return base;

  if (state.days && typeof state.days === "object") {
    base.days = { ...state.days };
  } else if (state.today && state.date) {
    // migrate from the earlier counter-only version
    base.days[state.date] = {
      replies: (state.today && state.today.replies) || 0,
      solved: (state.today && state.today.solved) || 0,
      blocks: [],
    };
  }

  base.goals = { ...DEFAULT_GOALS, ...(state.goals || {}) };

  for (const key of Object.keys(base.days)) {
    const d = base.days[key] || {};
    const blockStats = cleanBlockStats(d.blockStats);
    // The active-block set is the union of any legacy `blocks` array and the
    // keys of blockStats, so the two views can never disagree about activity.
    const legacyBlocks = Array.isArray(d.blocks) ? d.blocks : [];
    const active = new Set([
      ...legacyBlocks.filter((n) => Number.isInteger(n) && n >= 0 && n < BLOCKS_PER_DAY),
      ...Object.keys(blockStats).map(Number),
    ]);
    base.days[key] = {
      replies: d.replies || 0,
      solved: d.solved || 0,
      blocks: [...active].sort((a, b) => a - b),
      blockStats,
    };
  }
  return base;
}

/**
 * Apply a submit to the state: bump reply/solved counts and mark the current
 * 30-minute block productive. Returns a new state.
 * @param {object} state
 * @param {{replies:number, solved:number, activity:boolean}} delta
 * @param {Date} when
 * @returns {object}
 */
export function applyActivity(state, delta, when = new Date()) {
  const next = normalize(state);
  const key = localDateKey(when);
  const day = next.days[key] ? { ...next.days[key] } : emptyDay();
  day.replies += delta.replies || 0;
  day.solved += delta.solved || 0;
  if (delta.activity) {
    const bi = blockIndex(when);
    if (!day.blocks.includes(bi)) {
      day.blocks = [...day.blocks, bi].sort((a, b) => a - b);
    }
    const prev = day.blockStats[bi] || { replies: 0, solved: 0 };
    day.blockStats = {
      ...day.blockStats,
      [bi]: {
        replies: prev.replies + (delta.replies || 0),
        solved: prev.solved + (delta.solved || 0),
      },
    };
  }
  next.days = { ...next.days, [key]: day };
  return next;
}

// --- Derived metrics ----------------------------------------------------------

/** Per-day metrics including productive time and per-productive-hour rates. */
export function dayMetrics(day) {
  const d = { ...emptyDay(), ...(day || {}) };
  const productiveBlocks = d.blocks.length;
  const productiveHours = productiveBlocks * 0.5;
  return {
    replies: d.replies,
    solved: d.solved,
    productiveBlocks,
    productiveHours,
    repliesPerHour: productiveHours ? d.replies / productiveHours : 0,
    solvedPerHour: productiveHours ? d.solved / productiveHours : 0,
  };
}

/** Metrics for a given date key (today by default). */
export function metricsForDate(state, dateKey = localDateKey()) {
  const s = normalize(state);
  return dayMetrics(s.days[dateKey] || emptyDay());
}

/** All-time totals aggregated across every recorded day. */
export function totals(state) {
  const s = normalize(state);
  let replies = 0;
  let solved = 0;
  let productiveBlocks = 0;
  for (const key of Object.keys(s.days)) {
    replies += s.days[key].replies;
    solved += s.days[key].solved;
    productiveBlocks += s.days[key].blocks.length;
  }
  const productiveHours = productiveBlocks * 0.5;
  return {
    replies,
    solved,
    productiveBlocks,
    productiveHours,
    repliesPerHour: productiveHours ? replies / productiveHours : 0,
    solvedPerHour: productiveHours ? solved / productiveHours : 0,
  };
}

/** Days sorted newest-first, each with its date key and metrics. */
export function sortedDays(state) {
  const s = normalize(state);
  return Object.keys(s.days)
    .sort((a, b) => (a < b ? 1 : -1))
    .map((date) => ({ date, ...dayMetrics(s.days[date]) }));
}

// --- Weeks (Monday–Friday work weeks) ----------------------------------------

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

/** Shift a YYYY-MM-DD key by n days (local). */
export function addDaysKey(dateKey, n) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localDateKey(dt);
}

/** The Monday (YYYY-MM-DD) of the week containing the given date. */
export function mondayOf(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const dow = dt.getDay(); // 0 Sun .. 6 Sat
  dt.setDate(dt.getDate() + (dow === 0 ? -6 : 1 - dow));
  return localDateKey(dt);
}

/** True for Saturday/Sunday keys. */
export function isWeekend(dateKey) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

/** The five weekday keys (Mon–Fri) for a given Monday. */
export function weekdayKeys(mondayKey) {
  return [0, 1, 2, 3, 4].map((n) => addDaysKey(mondayKey, n));
}

/**
 * Aggregate a Monday–Friday work week. Weekend days are excluded by design.
 * Rates are over the week's total productive hours.
 * @param {object} state
 * @param {string} mondayKey
 */
export function weekAggregate(state, mondayKey) {
  const s = normalize(state);
  const keys = weekdayKeys(mondayKey);
  const days = keys.map((date, i) => ({
    date,
    weekday: WEEKDAY_LABELS[i],
    present: !!s.days[date],
    metrics: dayMetrics(s.days[date] || emptyDay()),
    day: s.days[date] || emptyDay(),
  }));
  let replies = 0;
  let solved = 0;
  let productiveBlocks = 0;
  let worked = 0;
  for (const d of days) {
    replies += d.metrics.replies;
    solved += d.metrics.solved;
    productiveBlocks += d.metrics.productiveBlocks;
    if (d.metrics.productiveBlocks > 0) worked += 1;
  }
  const productiveHours = productiveBlocks * 0.5;
  return {
    monday: mondayKey,
    friday: keys[4],
    days,
    worked,
    replies,
    solved,
    productiveBlocks,
    productiveHours,
    repliesPerHour: productiveHours ? replies / productiveHours : 0,
    solvedPerHour: productiveHours ? solved / productiveHours : 0,
  };
}

/** Monday keys (newest-first) for weeks that have any Mon–Fri activity. */
export function sortedWeeks(state) {
  const s = normalize(state);
  const set = new Set();
  for (const date of Object.keys(s.days)) {
    if (isWeekend(date)) continue; // weekend activity doesn't create a week report
    if (s.days[date].blocks.length === 0) continue;
    set.add(mondayOf(date));
  }
  return [...set].sort((a, b) => (a < b ? 1 : -1));
}

/**
 * The day as 48 half-hour blocks for the dashboard timeline. Each entry carries
 * its per-block reply/solved counts and the equivalent per-hour rate (a 30-min
 * block of N counts = N × 2 per hour).
 * @param {object} day
 * @returns {Array<{index:number,label:string,active:boolean,replies:number,solved:number,repliesPerHour:number,solvedPerHour:number}>}
 */
export function blockSeries(day) {
  const d = { ...emptyDay(), ...(day || {}) };
  const activeSet = new Set(d.blocks);
  const series = [];
  for (let i = 0; i < BLOCKS_PER_DAY; i++) {
    const bs = d.blockStats[i] || { replies: 0, solved: 0 };
    series.push({
      index: i,
      label: blockLabel(i),
      active: activeSet.has(i),
      replies: bs.replies,
      solved: bs.solved,
      repliesPerHour: bs.replies * 2,
      solvedPerHour: bs.solved * 2,
    });
  }
  return series;
}

// --- Rates (for the toolbar icon) --------------------------------------------

/** Format a rate to exactly one decimal, e.g. 6.5 -> "6.5", 8 -> "8.0". */
export function formatRate(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/**
 * Compact rate for the toolbar icon: one decimal below 10, but a whole number
 * from 10 up (…9.9, then 10, 11…) so the digits stay large and never become a
 * four-character "10.0". The switch is based on the *rounded* value, so 9.95
 * shows as "10", not "10.0".
 */
export function formatIconRate(n) {
  const oneDecimal = Math.round(n * 10) / 10;
  return oneDecimal >= 10 ? String(Math.round(n)) : oneDecimal.toFixed(1);
}

/**
 * Today's solved/hr and replies/hr with whether each is at or above target.
 * A rate only counts as "on target" once there is some productive time.
 * @param {object} state
 * @param {string} dateKey
 * @returns {{solvedRate:number, repliesRate:number, solvedOnTarget:boolean, repliesOnTarget:boolean, productiveHours:number}}
 */
export function todayRates(state, dateKey = localDateKey()) {
  const s = normalize(state);
  const m = metricsForDate(s, dateKey);
  const g = s.goals;
  return {
    solvedRate: m.solvedPerHour,
    repliesRate: m.repliesPerHour,
    productiveHours: m.productiveHours,
    solvedOnTarget: m.productiveHours > 0 && m.solvedPerHour >= g.solvedPerHour,
    repliesOnTarget: m.productiveHours > 0 && m.repliesPerHour >= g.repliesPerHour,
  };
}

// --- "Act now?" slot advisor -------------------------------------------------

// When fewer than this many minutes remain in an idle block, suggest waiting:
// starting now would give you less than this much usable time in the block
// before it rolls over.
export const SLOT_WAIT_THRESHOLD_MIN = 15;

/**
 * Whether *now* is a good moment to handle a ticket, from a block-efficiency
 * angle:
 *  - "active": the current 30-min block already has activity — keep going, it's
 *    already counted.
 *  - "go": the current block is idle but has plenty of time left — starting now
 *    books it with room to work.
 *  - "wait": the current block is idle and nearly over — waiting a moment lets
 *    your next ticket book a fresh full block instead of this near-empty one.
 * @param {object} state
 * @param {Date} now
 * @param {number} waitThresholdMin
 */
export function slotStatus(state, now = new Date(), waitThresholdMin = SLOT_WAIT_THRESHOLD_MIN) {
  const s = normalize(state);
  const day = s.days[localDateKey(now)] || emptyDay();
  const idx = blockIndex(now);
  const booked = day.blocks.includes(idx);
  const minsLeft = 30 - ((now.getMinutes() % 30) + now.getSeconds() / 60);
  let status;
  if (booked) status = "active";
  else if (minsLeft < waitThresholdMin) status = "wait";
  else status = "go";
  return {
    status,
    booked,
    blockStart: blockLabel(idx),
    blockEnd: blockLabel((idx + 1) % BLOCKS_PER_DAY),
    minsLeft,
    minsLeftCeil: Math.max(1, Math.ceil(minsLeft)),
    waitThresholdMin,
  };
}

// --- Progress color (for the toolbar icon) -----------------------------------
//
// A rate's color reflects how close it is to its target (ratio = rate / goal):
//   0%   -> red      (smoothly...)
//   50%  -> amber    (...blending...)
//   100% -> green    (...through to green)
//   100%–150% -> stays solid green
//   >=150% -> purple (overachieving)

export const RATE_COLORS = {
  red: "#ff4d4d",
  amber: "#ffb020",
  green: "#3ad07a",
  purple: "#c77dff",
};

function hexToRgb(h) {
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb) {
  return (
    "#" +
    rgb
      .map((x) => Math.round(Math.min(255, Math.max(0, x))).toString(16).padStart(2, "0"))
      .join("")
  );
}

function lerpHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
}

/**
 * Color for a rate given its goal: red -> amber -> green across 0..100% of goal,
 * solid green from 100%..150%, purple at >=150%.
 * @param {number} rate
 * @param {number} goal
 * @returns {string} hex color
 */
export function progressColor(rate, goal) {
  const ratio = goal > 0 ? rate / goal : rate > 0 ? 2 : 1; // 0-goal edge case
  if (ratio <= 0) return RATE_COLORS.red;
  if (ratio >= 1.5) return RATE_COLORS.purple;
  if (ratio >= 1.0) return RATE_COLORS.green;
  if (ratio >= 0.5) return lerpHex(RATE_COLORS.amber, RATE_COLORS.green, (ratio - 0.5) / 0.5);
  return lerpHex(RATE_COLORS.red, RATE_COLORS.amber, ratio / 0.5);
}

// Hidden bonus tier: a split above this multiple of its goal earns the animated
// rainbow treatment instead of purple.
export const BONUS_RATIO = 3.33; // 333% of goal

/** True when a rate is more than 333% of its goal (the rainbow bonus tier). */
export function isBonusRate(rate, goal) {
  return goal > 0 && rate / goal > BONUS_RATIO;
}

// --- Export / import ----------------------------------------------------------

export const APP_ID = "zendesk-productivity-tracker";
export const SCHEMA_VERSION = 1;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nonNegInt(v) {
  return Math.max(0, Math.floor(Number(v) || 0));
}

/** Drop unrecognized day keys and clamp values — imported files are untrusted. */
function sanitizeDays(days) {
  const out = {};
  if (!days || typeof days !== "object") return out;
  for (const [key, val] of Object.entries(days)) {
    if (!DATE_RE.test(key) || !val || typeof val !== "object") continue;
    const blocks = Array.isArray(val.blocks)
      ? val.blocks.filter((n) => Number.isInteger(n) && n >= 0 && n < BLOCKS_PER_DAY)
      : [];
    // normalize() re-derives/cleans blockStats and the active set; here we only
    // need to pass through a plausibly-shaped map for it to sanitize.
    out[key] = {
      replies: nonNegInt(val.replies),
      solved: nonNegInt(val.solved),
      blocks: [...new Set(blocks)].sort((a, b) => a - b),
      blockStats: val.blockStats && typeof val.blockStats === "object" ? val.blockStats : {},
    };
  }
  return out;
}

// Invalid targets (negative or non-numeric) fall back to the default rather than
// clamping to 0 — a 0 target would make every rate trivially "on target".
function sanitizeGoal(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

function sanitizeGoals(goals) {
  if (!goals || typeof goals !== "object") return { ...DEFAULT_GOALS };
  return {
    repliesPerHour: sanitizeGoal(goals.repliesPerHour, DEFAULT_GOALS.repliesPerHour),
    solvedPerHour: sanitizeGoal(goals.solvedPerHour, DEFAULT_GOALS.solvedPerHour),
  };
}

/**
 * Build the portable export object (self-describing, versioned).
 * @param {object} state
 * @returns {object}
 */
export function serializeState(state, now = new Date()) {
  const s = normalize(state);
  return {
    app: APP_ID,
    schema: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data: { days: s.days, goals: s.goals },
  };
}

/**
 * Parse and validate an imported file's text. Accepts either the wrapped export
 * format ({ app, schema, data }) or a raw state object ({ days, goals }).
 * @param {string} text
 * @returns {{ok:true, state:object, dayCount:number} | {ok:false, error:string}}
 */
export function parseImport(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file isn't valid JSON." };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, error: "Unrecognized file format." };
  }
  const payload =
    json.data && typeof json.data === "object" ? json.data : json;
  if (!payload.days || typeof payload.days !== "object" || Array.isArray(payload.days)) {
    return { ok: false, error: "No tracking data found in that file." };
  }
  const state = normalize({
    days: sanitizeDays(payload.days),
    goals: sanitizeGoals(payload.goals),
  });
  return { ok: true, state, dayCount: Object.keys(state.days).length };
}

/**
 * Merge `incoming` into `base`. For overlapping days the higher reply/solved
 * counts are kept and productive blocks are unioned; the base device's goals are
 * preserved. Non-overlapping days are simply added.
 * @param {object} base
 * @param {object} incoming
 * @returns {object}
 */
export function mergeStates(base, incoming) {
  const a = normalize(base);
  const b = normalize(incoming);
  const days = { ...a.days };
  for (const [date, d] of Object.entries(b.days)) {
    const cur = days[date];
    if (!cur) {
      days[date] = d;
      continue;
    }
    // Per-block: keep the higher count in each block, consistent with the
    // max-per-day rule.
    const blockStats = { ...cur.blockStats };
    for (const [idx, bs] of Object.entries(d.blockStats)) {
      const p = blockStats[idx] || { replies: 0, solved: 0 };
      blockStats[idx] = {
        replies: Math.max(p.replies, bs.replies),
        solved: Math.max(p.solved, bs.solved),
      };
    }
    days[date] = {
      replies: Math.max(cur.replies, d.replies),
      solved: Math.max(cur.solved, d.solved),
      blocks: [...new Set([...cur.blocks, ...d.blocks])].sort((x, y) => x - y),
      blockStats,
    };
  }
  return normalize({ days, goals: a.goals });
}
