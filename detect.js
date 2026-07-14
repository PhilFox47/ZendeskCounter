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
  return { replies: 0, solved: 0, blocks: [] };
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
    const blocks = Array.isArray(d.blocks) ? d.blocks : [];
    base.days[key] = {
      replies: d.replies || 0,
      solved: d.solved || 0,
      blocks: [...new Set(blocks)].sort((a, b) => a - b),
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

// --- Rates (for the toolbar icon) --------------------------------------------

/** Format a rate to exactly one decimal, e.g. 6.5 -> "6.5", 8 -> "8.0". */
export function formatRate(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
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
