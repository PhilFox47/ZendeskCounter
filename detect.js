// Pure, dependency-free detection + counting logic for the Zendesk ticket counter.
// Kept separate from background.js so it can be unit-tested in Node against real
// captured GraphQL payloads (see test/detect.test.mjs).

export const UPDATE_TICKET_OPERATION = "UpdateTicketMutation";

/**
 * Parse a GraphQL request body (string) into an array of operation objects.
 * Zendesk sends either a single operation object or an array of them.
 * Returns [] if the body is not valid JSON.
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

  // A public reply is a comment explicitly flagged public. Internal notes have
  // isPublic === false and must not count.
  const comment = ticket.comment;
  const isPublicReply = !!(comment && comment.isPublic === true);

  // "Solved" is submitted as status === "SOLVED". A reply that only moves the
  // ticket to PENDING (or omits status entirely) is not a solve.
  const isSolved =
    typeof ticket.status === "string" && ticket.status.toUpperCase() === "SOLVED";

  return { isPublicReply, isSolved };
}

/**
 * Given a full GraphQL request body, return the aggregated counting delta for
 * any UpdateTicketMutation operations it contains.
 * @param {string} text
 * @returns {{replies: number, solved: number}}
 */
export function deltaFromRequestBody(text) {
  const ops = parseGraphQLBody(text);
  let replies = 0;
  let solved = 0;
  for (const op of ops) {
    if (!op || op.operationName !== UPDATE_TICKET_OPERATION) continue;
    const { isPublicReply, isSolved } = analyzeUpdateTicket(op.variables || {});
    if (isPublicReply) replies += 1;
    if (isSolved) solved += 1;
  }
  return { replies, solved };
}

/**
 * Local calendar date string (YYYY-MM-DD) for daily rollover.
 * @param {Date} [date]
 * @returns {string}
 */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function emptyState(todayKey = localDateKey()) {
  return {
    date: todayKey,
    today: { replies: 0, solved: 0 },
    total: { replies: 0, solved: 0 },
    badgeMetric: "solved", // "solved" | "replies" | "total"
  };
}

/**
 * Normalize a possibly-missing/partial stored state into a full state object,
 * applying the daily rollover: if the stored date is not today, today's
 * counters reset to zero while all-time totals are preserved.
 * @param {object|undefined} state
 * @param {string} todayKey
 * @returns {object}
 */
export function rollover(state, todayKey = localDateKey()) {
  const base = { ...emptyState(todayKey), ...(state || {}) };
  base.today = { replies: 0, solved: 0, ...(state && state.today) };
  base.total = { replies: 0, solved: 0, ...(state && state.total) };
  if (base.date !== todayKey) {
    base.date = todayKey;
    base.today = { replies: 0, solved: 0 };
  }
  if (!["solved", "replies", "total"].includes(base.badgeMetric)) {
    base.badgeMetric = "solved";
  }
  return base;
}

/**
 * Apply a counting delta to a state (after rollover), returning a new state.
 * @param {object} state
 * @param {{replies:number, solved:number}} delta
 * @param {string} todayKey
 * @returns {object}
 */
export function applyDelta(state, delta, todayKey = localDateKey()) {
  const next = rollover(state, todayKey);
  next.today = {
    replies: next.today.replies + (delta.replies || 0),
    solved: next.today.solved + (delta.solved || 0),
  };
  next.total = {
    replies: next.total.replies + (delta.replies || 0),
    solved: next.total.solved + (delta.solved || 0),
  };
  return next;
}

/**
 * The number the toolbar badge should show for the selected metric (today).
 * @param {object} state
 * @returns {number}
 */
export function badgeValue(state) {
  const t = state.today || { replies: 0, solved: 0 };
  switch (state.badgeMetric) {
    case "replies":
      return t.replies;
    case "total":
      return t.replies + t.solved;
    case "solved":
    default:
      return t.solved;
  }
}
