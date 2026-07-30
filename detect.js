// Pure, dependency-free detection + counting logic for the Zendesk productivity
// tracker. Kept separate from background.js so it can be unit-tested in Node
// against real captured GraphQL payloads (see test/detect.test.mjs).

export const UPDATE_TICKET_OPERATION = "UpdateTicketMutation";
export const CREATE_TICKET_OPERATION = "CreateIssueTicketMutation";
// Both mutations carry the same ticket shape ({ comment.isPublic, status }),
// so the same analyzer handles updates and independent new tickets.
const TICKET_MUTATIONS = new Set([UPDATE_TICKET_OPERATION, CREATE_TICKET_OPERATION]);

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
    if (!op || !TICKET_MUTATIONS.has(op.operationName)) continue;
    activity = true;
    const { isPublicReply, isSolved } = analyzeUpdateTicket(op.variables || {});
    if (isPublicReply) replies += 1;
    if (isSolved) solved += 1;
  }
  return { replies, solved, activity };
}

/**
 * Counting delta for a REST "create ticket" body (POST /api/v2/tickets.json).
 * New tickets are created through the REST API, not the GraphQL mutation. The
 * initial comment defaults to public (it emails the requester), so it counts as
 * a public reply unless explicitly flagged internal (comment.public === false).
 * @param {string} text
 * @returns {{replies: number, solved: number, activity: boolean}}
 */
export function deltaFromTicketCreate(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { replies: 0, solved: 0, activity: false };
  }
  const t = json && json.ticket;
  if (!t || typeof t !== "object") return { replies: 0, solved: 0, activity: false };
  const c = t.comment;
  const hasComment = c && typeof c === "object";
  const replies = hasComment && c.public !== false ? 1 : 0;
  const solved =
    typeof t.status === "string" && t.status.toLowerCase() === "solved" ? 1 : 0;
  return { replies, solved, activity: true };
}

/**
 * Route a captured request to the right parser by URL. Ticket updates
 * (replies / solves / notes) go through GraphQL; new tickets go through the
 * REST create endpoint.
 * @param {string} url
 * @param {string} method
 * @param {string} body
 * @returns {{replies: number, solved: number, activity: boolean}}
 */
export function deltaFromRequest(url, method, body) {
  if (/\/api\/graphql/.test(url)) return deltaFromRequestBody(body);
  if (method === "POST" && /\/api\/v2\/tickets\.json/.test(url)) {
    return deltaFromTicketCreate(body);
  }
  return { replies: 0, solved: 0, activity: false };
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

/**
 * Per-day metrics including productive time and per-productive-hour rates.
 * When `awayDay` (that date's entry from the awayTime store) is given, chat/call
 * seconds that fall *within productive blocks* are deducted from productive time,
 * so rates reflect only ticket-available time. Time on calls/chats outside your
 * ticket blocks isn't deducted (there was no productive time there to remove).
 */
export function dayMetrics(day, awayDay) {
  const d = { ...emptyDay(), ...(day || {}) };
  const productiveBlocks = d.blocks.length;
  const rawProductiveHours = productiveBlocks * 0.5;

  let deductedSec = 0;
  for (const idx of d.blocks) deductedSec += awayBlockSec(awayDay, idx);
  const productiveHours = Math.max(0, rawProductiveHours - deductedSec / 3600);

  return {
    replies: d.replies,
    solved: d.solved,
    productiveBlocks,
    rawProductiveHours,
    deductedSec,
    productiveHours,
    repliesPerHour: productiveHours ? d.replies / productiveHours : 0,
    solvedPerHour: productiveHours ? d.solved / productiveHours : 0,
  };
}

/** Metrics for a given date key (today by default), optionally away-adjusted. */
export function metricsForDate(state, dateKey = localDateKey(), away) {
  const s = normalize(state);
  const awayDay = away ? normalizeAway(away)[dateKey] : undefined;
  return dayMetrics(s.days[dateKey] || emptyDay(), awayDay);
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

/** Days sorted newest-first, each with its date key and metrics (away-adjusted). */
export function sortedDays(state, away) {
  const s = normalize(state);
  const aw = away ? normalizeAway(away) : null;
  return Object.keys(s.days)
    .sort((a, b) => (a < b ? 1 : -1))
    .map((date) => ({ date, ...dayMetrics(s.days[date], aw ? aw[date] : undefined) }));
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
export function weekAggregate(state, mondayKey, away) {
  const s = normalize(state);
  const aw = away ? normalizeAway(away) : null;
  const keys = weekdayKeys(mondayKey);
  const days = keys.map((date, i) => ({
    date,
    weekday: WEEKDAY_LABELS[i],
    present: !!s.days[date],
    metrics: dayMetrics(s.days[date] || emptyDay(), aw ? aw[date] : undefined),
    day: s.days[date] || emptyDay(),
  }));
  let replies = 0;
  let solved = 0;
  let productiveBlocks = 0;
  let productiveHours = 0;
  let worked = 0;
  for (const d of days) {
    replies += d.metrics.replies;
    solved += d.metrics.solved;
    productiveBlocks += d.metrics.productiveBlocks;
    productiveHours += d.metrics.productiveHours; // already away-adjusted per day
    if (d.metrics.productiveBlocks > 0) worked += 1;
  }
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
export function todayRates(state, dateKey = localDateKey(), away) {
  const s = normalize(state);
  const m = metricsForDate(s, dateKey, away);
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
export function serializeState(state, now = new Date(), away) {
  const s = normalize(state);
  return {
    app: APP_ID,
    schema: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    data: { days: s.days, goals: s.goals, away: normalizeAway(away || {}) },
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
  const away = normalizeAway(payload.away); // chat/call time (absent in old exports)
  return { ok: true, state, away, dayCount: Object.keys(state.days).length };
}

/**
 * Merge two away maps. Consistent with mergeStates: overlapping days keep the
 * higher chat/call totals and per-block max, so re-importing your own export
 * won't double-count.
 */
export function mergeAway(base, incoming) {
  const a = normalizeAway(base);
  const b = normalizeAway(incoming);
  const out = { ...a };
  for (const [date, d] of Object.entries(b)) {
    const cur = out[date];
    if (!cur) {
      out[date] = d;
      continue;
    }
    const blockSec = { ...cur.blockSec };
    for (const [idx, sec] of Object.entries(d.blockSec)) {
      blockSec[idx] = Math.max(blockSec[idx] || 0, sec);
    }
    out[date] = {
      chatSec: Math.max(cur.chatSec, d.chatSec),
      callSec: Math.max(cur.callSec, d.callSec),
      blockSec,
    };
  }
  return normalizeAway(out);
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

// --- Presence: active chat / phone time (auto-detected) ----------------------
//
// Kept in a separate storage structure from `counterState` so it never disturbs
// the reply/solve/block metrics. `awayTime` accumulates seconds spent in chats
// and calls per local day; `presenceState` holds the current live status; logs
// are a capped ring buffer for troubleshooting detection.

export const PRESENCE_STATES = ["idle", "chat", "call"];
export const LOG_CAP = 800;
// Don't attribute more than this to a single accrual step — guards against
// counting through a suspended service worker / sleep.
export const ACCRUE_CAP_SEC = 45;

export function emptyAway() {
  return {}; // { "YYYY-MM-DD": { chatSec, callSec, blockSec: { idx: sec } } }
}

// Clean a per-block away-seconds map ({ "<idx>": seconds }).
function cleanBlockSec(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    const idx = Number(k);
    if (!Number.isInteger(idx) || idx < 0 || idx >= BLOCKS_PER_DAY) continue;
    const sec = Math.max(0, Math.floor(Number(v) || 0));
    if (sec > 0) out[idx] = sec;
  }
  return out;
}

export function normalizeAway(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !v || typeof v !== "object") continue;
    out[k] = {
      chatSec: Math.max(0, Math.floor(Number(v.chatSec) || 0)),
      callSec: Math.max(0, Math.floor(Number(v.callSec) || 0)),
      blockSec: cleanBlockSec(v.blockSec),
    };
  }
  return out;
}

/**
 * Add `seconds` of chat/call time to a day, returning a new away map. When a
 * `blockIdx` is given, the seconds are also attributed to that 30-min block so
 * they can be deducted precisely from that block's productive time.
 */
export function addAway(away, dateKey, kind, seconds, blockIdx) {
  const next = normalizeAway(away);
  const sec = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!sec || (kind !== "chat" && kind !== "call")) return next;
  const day = next[dateKey] || { chatSec: 0, callSec: 0, blockSec: {} };
  const blockSec = { ...day.blockSec };
  if (Number.isInteger(blockIdx) && blockIdx >= 0 && blockIdx < BLOCKS_PER_DAY) {
    blockSec[blockIdx] = (blockSec[blockIdx] || 0) + sec;
  }
  next[dateKey] = {
    chatSec: day.chatSec + (kind === "chat" ? sec : 0),
    callSec: day.callSec + (kind === "call" ? sec : 0),
    blockSec,
  };
  return next;
}

/** Away seconds recorded within a single block (capped at the 30-min block). */
export function awayBlockSec(awayDay, idx) {
  const bs = awayDay && awayDay.blockSec ? awayDay.blockSec[idx] : 0;
  return Math.min(1800, Math.max(0, Number(bs) || 0));
}

/** Away totals for a date, plus a rounded-minutes convenience. */
export function awayForDate(away, dateKey = localDateKey()) {
  const a = normalizeAway(away)[dateKey] || { chatSec: 0, callSec: 0 };
  return {
    chatSec: a.chatSec,
    callSec: a.callSec,
    totalSec: a.chatSec + a.callSec,
    chatMin: Math.round(a.chatSec / 60),
    callMin: Math.round(a.callSec / 60),
    totalMin: Math.round((a.chatSec + a.callSec) / 60),
  };
}

/** Merge many per-tab presence states into one: call > chat > idle. */
export function mergePresence(states) {
  let sawChat = false;
  for (const s of states) {
    if (s === "call") return "call";
    if (s === "chat") sawChat = true;
  }
  return sawChat ? "chat" : "idle";
}

/** Which away bucket a merged presence state accrues to (or null for idle). */
export function presenceKind(state) {
  if (state === "call") return "call";
  if (state === "chat") return "chat";
  return null;
}

/** Append a log entry to a capped ring buffer, returning a new array. */
export function appendLog(logs, entry, cap = LOG_CAP) {
  const arr = Array.isArray(logs) ? logs.slice() : [];
  arr.push(entry);
  return arr.length > cap ? arr.slice(arr.length - cap) : arr;
}

/** Render logs (and optional away summary) as plain text for export. */
export function formatLogsForExport(logs, meta = {}) {
  const header = [
    `Ticket Telemetry — presence log export`,
    `generated: ${new Date().toISOString()}`,
    meta.version ? `version: ${meta.version}` : null,
    meta.away ? `away today: chat ${meta.away.chatMin}m · call ${meta.away.callMin}m` : null,
    `entries: ${Array.isArray(logs) ? logs.length : 0}`,
  ].filter(Boolean);

  // Per-day chat/call breakdown (newest first) when the full away map is given.
  if (meta.awayByDay && typeof meta.awayByDay === "object") {
    const dates = Object.keys(normalizeAway(meta.awayByDay)).sort((a, b) => (a < b ? 1 : -1));
    if (dates.length) {
      header.push("", "chat / call time per day:");
      for (const d of dates) {
        const a = awayForDate(meta.awayByDay, d);
        header.push(`  ${d}: chat ${a.chatMin}m · call ${a.callMin}m · total ${a.totalMin}m`);
      }
    }
  }
  header.push("".padEnd(60, "-"));

  const lines = (Array.isArray(logs) ? logs : []).map((e) => {
    const ts = e.ts ? new Date(e.ts).toISOString() : "?";
    const detail = e.detail ? " " + (typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)) : "";
    return `${ts} [${e.level || "info"}] ${e.msg || ""}${detail}`;
  });
  return header.concat(lines).join("\n") + "\n";
}
