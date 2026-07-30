// Verifies detection, productivity blocks, and per-day rates against the three
// real Zendesk scenarios (reproduced below as fixtures) plus edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deltaFromRequestBody,
  deltaFromTicketCreate,
  deltaFromRequest,
  analyzeUpdateTicket,
  applyActivity,
  normalize,
  metricsForDate,
  dayMetrics,
  totals,
  sortedDays,
  blockSeries,
  slotStatus,
  todayRates,
  formatRate,
  formatIconRate,
  blockIndex,
  localDateKey,
  serializeState,
  parseImport,
  mergeStates,
  progressColor,
  isBonusRate,
  RATE_COLORS,
  APP_ID,
} from "../detect.js";

// --- Fixtures: faithful UpdateTicketMutation bodies --------------------------

const publicReplyPending = JSON.stringify({
  operationName: "UpdateTicketMutation",
  variables: {
    ticket: {
      status: "PENDING",
      comment: { body: { value: "hi", format: "HTML" }, isPublic: true },
    },
  },
});

const publicReplySolved = JSON.stringify({
  operationName: "UpdateTicketMutation",
  variables: {
    ticket: {
      status: "SOLVED",
      comment: { body: { value: "done", format: "HTML" }, isPublic: true },
    },
  },
});

const internalNote = JSON.stringify({
  operationName: "UpdateTicketMutation",
  variables: {
    ticket: { comment: { body: { value: "note", format: "HTML" }, isPublic: false } },
  },
});

const unrelated = JSON.stringify({ operationName: "SomethingElse", variables: {} });

// Independent new ticket, created-and-solved (CreateIssueTicketMutation) — same
// shape as UpdateTicketMutation, faithful to the captured HAR.
const createTicketSolved = JSON.stringify({
  operationName: "CreateIssueTicketMutation",
  variables: {
    ticket: {
      status: "SOLVED",
      subject: "AW: DPD Paketklärungsinformation",
      comment: { body: { value: "reply", format: "HTML" }, isPublic: true },
    },
  },
});

// --- Detection ---------------------------------------------------------------

test("public reply, not solved -> reply + activity, no solve", () => {
  assert.deepEqual(deltaFromRequestBody(publicReplyPending), {
    replies: 1,
    solved: 0,
    activity: true,
  });
});

test("public reply + solved -> reply + solve + activity", () => {
  assert.deepEqual(deltaFromRequestBody(publicReplySolved), {
    replies: 1,
    solved: 1,
    activity: true,
  });
});

test("internal note -> no reply/solve but IS activity (marks productive)", () => {
  assert.deepEqual(deltaFromRequestBody(internalNote), {
    replies: 0,
    solved: 0,
    activity: true,
  });
});

test("independent new ticket (CreateIssueTicketMutation) counts reply + solve", () => {
  assert.deepEqual(deltaFromRequestBody(createTicketSolved), {
    replies: 1,
    solved: 1,
    activity: true,
  });
});

test("independent new ticket, public reply only (not solved)", () => {
  const body = JSON.stringify({
    operationName: "CreateIssueTicketMutation",
    variables: { ticket: { status: "OPEN", comment: { isPublic: true } } },
  });
  assert.deepEqual(deltaFromRequestBody(body), { replies: 1, solved: 0, activity: true });
});

// --- New ticket (REST create) — faithful to captured POST /api/v2/tickets.json

test("new ticket create counts as a public reply (comment public by default)", () => {
  const body = JSON.stringify({
    ticket: {
      subject: "Beschädigte Sendung",
      comment: { html_body: "<p>Hello</p>" }, // no `public` field -> defaults public
      requester: { email: "shop@example.com", name: "" },
    },
  });
  assert.deepEqual(deltaFromTicketCreate(body), { replies: 1, solved: 0, activity: true });
});

test("new ticket with an internal-only comment -> activity, no reply", () => {
  const body = JSON.stringify({ ticket: { comment: { body: "note", public: false } } });
  assert.deepEqual(deltaFromTicketCreate(body), { replies: 0, solved: 0, activity: true });
});

test("new ticket created-and-solved -> reply + solved", () => {
  const body = JSON.stringify({ ticket: { comment: { html_body: "x" }, status: "solved" } });
  assert.deepEqual(deltaFromTicketCreate(body), { replies: 1, solved: 1, activity: true });
});

test("ticket create with no comment -> activity only", () => {
  assert.deepEqual(deltaFromTicketCreate(JSON.stringify({ ticket: { subject: "x" } })), {
    replies: 0, solved: 0, activity: true,
  });
});

test("ticket create: malformed / non-ticket body -> nothing", () => {
  assert.deepEqual(deltaFromTicketCreate("nope"), { replies: 0, solved: 0, activity: false });
  assert.deepEqual(deltaFromTicketCreate(JSON.stringify({ foo: 1 })), {
    replies: 0, solved: 0, activity: false,
  });
});

test("deltaFromRequest routes GraphQL vs REST create by URL", () => {
  const create = JSON.stringify({ ticket: { comment: { html_body: "x" } } });
  // GraphQL update endpoint -> uses the mutation parser
  assert.deepEqual(
    deltaFromRequest("https://x.zendesk.com/api/graphql", "POST", publicReplySolved),
    { replies: 1, solved: 1, activity: true }
  );
  // REST create endpoint -> uses the create parser
  assert.deepEqual(
    deltaFromRequest("https://x.zendesk.com/api/v2/tickets.json", "POST", create),
    { replies: 1, solved: 0, activity: true }
  );
  // REST update (PUT to a specific ticket) is NOT treated as a create
  assert.deepEqual(
    deltaFromRequest("https://x.zendesk.com/api/v2/tickets/123.json", "PUT", create),
    { replies: 0, solved: 0, activity: false }
  );
});

test("unrelated GraphQL op -> no activity", () => {
  assert.deepEqual(deltaFromRequestBody(unrelated), {
    replies: 0,
    solved: 0,
    activity: false,
  });
});

test("malformed body does not throw", () => {
  assert.deepEqual(deltaFromRequestBody("not json"), {
    replies: 0,
    solved: 0,
    activity: false,
  });
});

test("analyzeUpdateTicket handles missing ticket", () => {
  assert.deepEqual(analyzeUpdateTicket({}), { isPublicReply: false, isSolved: false });
});

// --- Block indexing ----------------------------------------------------------

test("blockIndex maps 11:12 -> block 22 (11:00-11:30)", () => {
  assert.equal(blockIndex(new Date(2026, 6, 14, 11, 12)), 22);
});

test("blockIndex maps 11:45 -> block 23 (11:30-12:00)", () => {
  assert.equal(blockIndex(new Date(2026, 6, 14, 11, 45)), 23);
});

// --- Productivity + rates ----------------------------------------------------

test("two submits in the same 30-min block = one productive block", () => {
  let s = normalize(undefined);
  const t1 = new Date(2026, 6, 14, 11, 5);
  const t2 = new Date(2026, 6, 14, 11, 25);
  s = applyActivity(s, deltaFromRequestBody(publicReplyPending), t1);
  s = applyActivity(s, deltaFromRequestBody(internalNote), t2);
  const m = metricsForDate(s, "2026-07-14");
  assert.equal(m.productiveBlocks, 1);
  assert.equal(m.productiveHours, 0.5);
  assert.equal(m.replies, 1); // note doesn't add a reply
});

test("submits in different blocks accumulate productive time", () => {
  let s = normalize(undefined);
  s = applyActivity(s, deltaFromRequestBody(publicReplyPending), new Date(2026, 6, 14, 9, 10));
  s = applyActivity(s, deltaFromRequestBody(publicReplySolved), new Date(2026, 6, 14, 9, 40));
  s = applyActivity(s, deltaFromRequestBody(internalNote), new Date(2026, 6, 14, 15, 2));
  const m = metricsForDate(s, "2026-07-14");
  assert.equal(m.productiveBlocks, 3);
  assert.equal(m.productiveHours, 1.5);
  assert.equal(m.replies, 2);
  assert.equal(m.solved, 1);
});

test("rates are per productive hour", () => {
  // 1 productive block = 0.5h; 2 replies, 1 solved -> 4 repl/h, 2 solved/h
  let s = normalize(undefined);
  const when = new Date(2026, 6, 14, 11, 5);
  s = applyActivity(s, { replies: 2, solved: 1, activity: true }, when);
  const m = metricsForDate(s, "2026-07-14");
  assert.equal(m.productiveHours, 0.5);
  assert.equal(m.repliesPerHour, 4);
  assert.equal(m.solvedPerHour, 2);
});

test("no productive time -> zero rates, not NaN", () => {
  const m = dayMetrics({ replies: 0, solved: 0, blocks: [] });
  assert.equal(m.repliesPerHour, 0);
  assert.equal(m.solvedPerHour, 0);
});

test("per-block counts (blockStats) accumulate for the sector view", () => {
  let s = normalize(undefined);
  // block 22 (11:00): 2 replies + 1 solve; block 30 (15:00): 1 reply
  s = applyActivity(s, { replies: 1, solved: 1, activity: true }, new Date(2026, 6, 14, 11, 5));
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 14, 11, 25));
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 14, 15, 0));
  const series = blockSeries(s.days["2026-07-14"]);
  assert.equal(series.length, 48);
  assert.deepEqual(
    { replies: series[22].replies, solved: series[22].solved, active: series[22].active },
    { replies: 2, solved: 1, active: true }
  );
  assert.equal(series[22].repliesPerHour, 4); // 2 in 30 min = 4/hr
  assert.equal(series[22].solvedPerHour, 2);
  assert.equal(series[30].replies, 1);
  assert.equal(series[23].active, false); // untouched block
  assert.equal(series[23].replies, 0);
  // per-block sums equal the day totals
  const totR = series.reduce((a, b) => a + b.replies, 0);
  const totS = series.reduce((a, b) => a + b.solved, 0);
  assert.equal(totR, 3);
  assert.equal(totS, 1);
});

test("legacy day (blocks array, no blockStats) yields an empty but valid series", () => {
  const s = normalize({ days: { "2026-07-14": { replies: 5, solved: 2, blocks: [10, 11] } } });
  const series = blockSeries(s.days["2026-07-14"]);
  assert.equal(series.length, 48);
  assert.equal(series[10].active, true); // still known to be active
  assert.equal(series[10].replies, 0); // but no per-block breakdown
});

// --- Weeks (Mon–Fri) ---------------------------------------------------------

test("mondayOf returns the Monday of that week", async () => {
  const { mondayOf } = await import("../detect.js");
  assert.equal(mondayOf("2026-07-14"), "2026-07-13"); // Tue -> Mon 13
  assert.equal(mondayOf("2026-07-13"), "2026-07-13"); // Mon -> itself
  assert.equal(mondayOf("2026-07-17"), "2026-07-13"); // Fri -> Mon 13
  assert.equal(mondayOf("2026-07-19"), "2026-07-13"); // Sun still belongs to that week
  assert.equal(mondayOf("2026-07-20"), "2026-07-20"); // next Mon
});

test("weekdayKeys yields Mon–Fri only", async () => {
  const { weekdayKeys } = await import("../detect.js");
  assert.deepEqual(weekdayKeys("2026-07-13"), [
    "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17",
  ]);
});

test("weekAggregate sums Mon–Fri and excludes the weekend", async () => {
  const { weekAggregate } = await import("../detect.js");
  let s = normalize(undefined);
  // Tue: 4 replies, 2 solved in one block (0.5h)
  s = applyActivity(s, { replies: 4, solved: 2, activity: true }, new Date(2026, 6, 14, 9, 0));
  // Thu: 2 replies, 1 solved in one block (0.5h)
  s = applyActivity(s, { replies: 2, solved: 1, activity: true }, new Date(2026, 6, 16, 10, 0));
  // Saturday: should be ignored by the weekly report
  s = applyActivity(s, { replies: 9, solved: 9, activity: true }, new Date(2026, 6, 18, 10, 0));
  const w = weekAggregate(s, "2026-07-13");
  assert.equal(w.replies, 6); // 4 + 2, Saturday's 9 excluded
  assert.equal(w.solved, 3);
  assert.equal(w.productiveHours, 1); // two 0.5h blocks
  assert.equal(w.worked, 2); // Tue + Thu
  assert.equal(w.repliesPerHour, 6); // 6 / 1h
  assert.equal(w.solvedPerHour, 3);
  assert.equal(w.days.length, 5);
  assert.equal(w.days[0].weekday, "Mon");
  assert.equal(w.days[1].metrics.replies, 4); // Tue
});

test("sortedWeeks lists weeks with weekday activity, newest first, no weekend-only", async () => {
  const { sortedWeeks } = await import("../detect.js");
  let s = normalize(undefined);
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 14)); // Tue wk of 13
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 21)); // Tue wk of 20
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 19)); // Sunday only
  const weeks = sortedWeeks(s);
  assert.deepEqual(weeks, ["2026-07-20", "2026-07-13"]); // newest first; Sunday didn't add wk of 13 twice nor a lone week
});

// --- "Act now?" slot advisor -------------------------------------------------

test("slotStatus: current block already active -> 'active' regardless of time", () => {
  // 13:28 -> block 26 (13:00–13:30); mark it active
  let s = normalize(undefined);
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 14, 13, 5));
  const r = slotStatus(s, new Date(2026, 6, 14, 13, 28));
  assert.equal(r.status, "active");
  assert.equal(r.booked, true);
  assert.equal(r.blockStart, "13:00");
  assert.equal(r.blockEnd, "13:30");
});

test("slotStatus: idle block with plenty of time -> 'go'", () => {
  const r = slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 10)); // 20 min left
  assert.equal(r.status, "go");
  assert.equal(r.booked, false);
  assert.equal(Math.round(r.minsLeft), 20);
});

test("slotStatus: idle block nearly over -> 'wait' with minutes left", () => {
  const r = slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 28)); // 2 min left
  assert.equal(r.status, "wait");
  assert.equal(r.minsLeftCeil, 2);
  assert.equal(r.blockEnd, "13:30");
});

test("slotStatus: warns when under 15 min would be available in a fresh slot", () => {
  // threshold 15 min, strictly less-than.
  // 13:15:00 -> exactly 15 min left -> still 'go' (15 is not < 15)
  assert.equal(slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 15, 0)).status, "go");
  // 13:16 -> 14 min left -> 'wait'
  assert.equal(slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 16)).status, "wait");
  // 13:10 -> 20 min left -> 'go'
  assert.equal(slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 10)).status, "go");
});

test("slotStatus: last block of the day wraps end label to 00:00", () => {
  const r = slotStatus(normalize(undefined), new Date(2026, 6, 14, 23, 45));
  assert.equal(r.blockStart, "23:30");
  assert.equal(r.blockEnd, "00:00");
});

// --- Per-day separation ------------------------------------------------------

test("activity is bucketed by local day", () => {
  let s = normalize(undefined);
  s = applyActivity(s, deltaFromRequestBody(publicReplySolved), new Date(2026, 6, 14, 10, 0));
  s = applyActivity(s, deltaFromRequestBody(publicReplyPending), new Date(2026, 6, 15, 10, 0));
  assert.equal(metricsForDate(s, "2026-07-14").solved, 1);
  assert.equal(metricsForDate(s, "2026-07-15").solved, 0);
  assert.equal(metricsForDate(s, "2026-07-15").replies, 1);
});

test("totals aggregate across days", () => {
  let s = normalize(undefined);
  s = applyActivity(s, { replies: 3, solved: 2, activity: true }, new Date(2026, 6, 14, 10, 0));
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 14, 12, 0));
  s = applyActivity(s, { replies: 2, solved: 1, activity: true }, new Date(2026, 6, 15, 9, 0));
  const t = totals(s);
  assert.equal(t.replies, 6);
  assert.equal(t.solved, 3);
  assert.equal(t.productiveBlocks, 3);
  assert.equal(t.productiveHours, 1.5);
});

test("sortedDays returns newest first with metrics", () => {
  let s = normalize(undefined);
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 14, 10, 0));
  s = applyActivity(s, { replies: 1, solved: 0, activity: true }, new Date(2026, 6, 15, 10, 0));
  const days = sortedDays(s);
  assert.equal(days[0].date, "2026-07-15");
  assert.equal(days[1].date, "2026-07-14");
});

// --- Icon rates --------------------------------------------------------------

test("formatRate always shows exactly one decimal", () => {
  assert.equal(formatRate(6.5), "6.5");
  assert.equal(formatRate(8), "8.0");
  assert.equal(formatRate(0), "0.0");
  assert.equal(formatRate(2.66), "2.7"); // rounds to one decimal
  assert.equal(formatRate(10), "10.0");
});

test("formatIconRate drops the decimal at 10 and above", () => {
  assert.equal(formatIconRate(2.7), "2.7");
  assert.equal(formatIconRate(6.5), "6.5");
  assert.equal(formatIconRate(0), "0.0");
  assert.equal(formatIconRate(9.9), "9.9"); // last one-decimal value
  assert.equal(formatIconRate(9.94), "9.9"); // rounds down, stays decimal
  assert.equal(formatIconRate(9.95), "10"); // would round to 10.0 -> integer instead
  assert.equal(formatIconRate(10), "10");
  assert.equal(formatIconRate(10.4), "10");
  assert.equal(formatIconRate(12.6), "13");
  assert.equal(formatIconRate(20), "20");
});

test("todayRates reports rates and per-target status", () => {
  // 0.5 productive hour; 3 solved -> 6/h (>=3 on target); 2 replies -> 4/h (<7 below)
  let s = normalize(undefined);
  const when = new Date(2026, 6, 14, 11, 5);
  s = applyActivity(s, { replies: 2, solved: 3, activity: true }, when);
  const r = todayRates(s, "2026-07-14");
  assert.equal(r.solvedRate, 6);
  assert.equal(r.repliesRate, 4);
  assert.equal(r.solvedOnTarget, true);
  assert.equal(r.repliesOnTarget, false);
});

test("todayRates: no productive time -> zero rates, nothing on target", () => {
  const r = todayRates(normalize(undefined), "2026-07-14");
  assert.equal(r.solvedRate, 0);
  assert.equal(r.repliesRate, 0);
  assert.equal(r.solvedOnTarget, false);
  assert.equal(r.repliesOnTarget, false);
});

test("todayRates respects custom goals", () => {
  let s = normalize({ days: {}, goals: { repliesPerHour: 4, solvedPerHour: 10 } });
  s = applyActivity(s, { replies: 3, solved: 3, activity: true }, new Date(2026, 6, 14, 11, 5));
  const r = todayRates(s, "2026-07-14");
  // 0.5h -> replies 6/h (>=4 ok), solved 6/h (<10 below)
  assert.equal(r.repliesOnTarget, true);
  assert.equal(r.solvedOnTarget, false);
});

// --- Migration / normalization ----------------------------------------------

test("normalize migrates the legacy counter-only shape", () => {
  const legacy = {
    date: "2026-07-10",
    today: { replies: 4, solved: 2 },
    total: { replies: 9, solved: 5 },
    badgeMetric: "replies",
  };
  const s = normalize(legacy);
  assert.equal(s.days["2026-07-10"].replies, 4);
  assert.equal(s.days["2026-07-10"].solved, 2);
  assert.deepEqual(s.days["2026-07-10"].blocks, []);
  assert.deepEqual(s.goals, { repliesPerHour: 7, solvedPerHour: 3 });
});

test("normalize dedupes and sorts blocks and defaults goals", () => {
  const s = normalize({ days: { "2026-07-14": { replies: 1, solved: 0, blocks: [5, 5, 2] } } });
  assert.deepEqual(s.days["2026-07-14"].blocks, [2, 5]);
  assert.deepEqual(s.goals, { repliesPerHour: 7, solvedPerHour: 3 });
});

test("custom goals are preserved through normalize", () => {
  const s = normalize({ days: {}, goals: { repliesPerHour: 10, solvedPerHour: 4 } });
  assert.deepEqual(s.goals, { repliesPerHour: 10, solvedPerHour: 4 });
});

// --- Export / import ---------------------------------------------------------

function seed(days, goals) {
  return normalize({ days, goals });
}

test("serializeState produces a versioned, self-describing envelope", () => {
  const s = seed({ "2026-07-14": { replies: 5, solved: 2, blocks: [10, 11] } });
  const out = serializeState(s, new Date("2026-07-14T12:00:00Z"));
  assert.equal(out.app, APP_ID);
  assert.equal(out.schema, 1);
  assert.equal(out.exportedAt, "2026-07-14T12:00:00.000Z");
  assert.deepEqual(out.data.days["2026-07-14"], {
    replies: 5, solved: 2, blocks: [10, 11], blockStats: {},
  });
});

test("export -> import round trip preserves data", () => {
  const s = seed(
    { "2026-07-14": { replies: 9, solved: 4, blocks: [20, 21, 22] } },
    { repliesPerHour: 6, solvedPerHour: 2 }
  );
  const text = JSON.stringify(serializeState(s));
  const res = parseImport(text);
  assert.equal(res.ok, true);
  assert.equal(res.dayCount, 1);
  assert.deepEqual(res.state.days["2026-07-14"], {
    replies: 9, solved: 4, blocks: [20, 21, 22], blockStats: {},
  });
  assert.deepEqual(res.state.goals, { repliesPerHour: 6, solvedPerHour: 2 });
});

test("parseImport accepts a raw state object (no envelope)", () => {
  const raw = JSON.stringify({ days: { "2026-07-14": { replies: 1, solved: 1, blocks: [0] } } });
  const res = parseImport(raw);
  assert.equal(res.ok, true);
  assert.equal(res.dayCount, 1);
});

test("parseImport rejects non-JSON and non-tracking files", () => {
  assert.equal(parseImport("nope").ok, false);
  assert.equal(parseImport("[1,2,3]").ok, false);
  assert.equal(parseImport(JSON.stringify({ hello: "world" })).ok, false);
});

test("parseImport sanitizes hostile/garbage day entries", () => {
  const dirty = JSON.stringify({
    data: {
      days: {
        "2026-07-14": { replies: -5, solved: 2.9, blocks: [10, 99, "x", 10] },
        "not-a-date": { replies: 1000, solved: 1000, blocks: [1] },
        "2026-07-15": "garbage",
      },
      goals: { repliesPerHour: -3, solvedPerHour: "abc" },
    },
  });
  const res = parseImport(dirty);
  assert.equal(res.ok, true);
  assert.equal(res.dayCount, 1); // bad date key and non-object day dropped
  assert.deepEqual(res.state.days["2026-07-14"], {
    replies: 0, // clamped from -5
    solved: 2, // floored from 2.9
    blocks: [10], // 99 out of range, "x" non-int, duplicate removed
    blockStats: {},
  });
  assert.equal(res.state.goals.repliesPerHour, 7); // invalid (-3) -> default
  assert.equal(res.state.goals.solvedPerHour, 3); // invalid ("abc") -> default
});

test("mergeStates unions blocks and keeps higher counts for overlapping days", () => {
  const base = seed(
    { "2026-07-14": { replies: 10, solved: 3, blocks: [10, 11] } },
    { repliesPerHour: 7, solvedPerHour: 3 }
  );
  const incoming = seed(
    {
      "2026-07-14": { replies: 4, solved: 5, blocks: [11, 12] },
      "2026-07-13": { replies: 8, solved: 2, blocks: [20] },
    },
    { repliesPerHour: 99, solvedPerHour: 99 }
  );
  const merged = mergeStates(base, incoming);
  assert.deepEqual(merged.days["2026-07-14"], {
    replies: 10, // max(10, 4)
    solved: 5, // max(3, 5)
    blocks: [10, 11, 12], // union
    blockStats: {},
  });
  assert.deepEqual(merged.days["2026-07-13"], {
    replies: 8, solved: 2, blocks: [20], blockStats: {},
  });
  assert.deepEqual(merged.goals, { repliesPerHour: 7, solvedPerHour: 3 }); // base goals kept
});

test("merging into an empty base equals the incoming data", () => {
  const incoming = seed({ "2026-07-14": { replies: 3, solved: 1, blocks: [5] } });
  const merged = mergeStates(normalize(undefined), incoming);
  assert.deepEqual(merged.days["2026-07-14"], {
    replies: 3, solved: 1, blocks: [5], blockStats: {},
  });
});

// --- Progress color ----------------------------------------------------------

test("progressColor hits the anchor colors exactly", () => {
  assert.equal(progressColor(0, 3), RATE_COLORS.red); // 0%
  assert.equal(progressColor(1.5, 3), RATE_COLORS.amber); // 50%
  assert.equal(progressColor(3, 3), RATE_COLORS.green); // 100%
  assert.equal(progressColor(4, 3), RATE_COLORS.green); // 133% stays green
  assert.equal(progressColor(4.5, 3), RATE_COLORS.purple); // 150%
  assert.equal(progressColor(9, 3), RATE_COLORS.purple); // 300%
});

test("progressColor blends between anchors (not equal to either endpoint)", () => {
  const q = progressColor(0.75, 3); // 25% -> between red and amber
  assert.notEqual(q, RATE_COLORS.red);
  assert.notEqual(q, RATE_COLORS.amber);
  assert.match(q, /^#[0-9a-f]{6}$/);

  const threeq = progressColor(2.25, 3); // 75% -> between amber and green
  assert.notEqual(threeq, RATE_COLORS.amber);
  assert.notEqual(threeq, RATE_COLORS.green);
});

test("progressColor is red just above zero and green/purple at goal edges", () => {
  assert.equal(progressColor(3, 3), RATE_COLORS.green); // exactly 100%
  assert.equal(progressColor(4.49, 3), RATE_COLORS.green); // just below 150%
  assert.equal(progressColor(4.5, 3), RATE_COLORS.purple); // exactly 150%
});

test("progressColor handles a zero goal without dividing by zero", () => {
  assert.equal(progressColor(0, 0), RATE_COLORS.green); // nothing required, nothing done
  assert.equal(progressColor(5, 0), RATE_COLORS.purple); // any output beats a 0 target
});

test("isBonusRate: rainbow tier is strictly above 333% of goal", () => {
  assert.equal(isBonusRate(9.99, 3), false); // ~333% -> still purple
  assert.equal(isBonusRate(10, 3), true); // >333% (6 solved in a 30-min block) -> bonus
  assert.equal(isBonusRate(8, 3), false); // 267% -> purple now (was bonus at 250%)
  assert.equal(isBonusRate(2.9, 3), false); // below target
  assert.equal(isBonusRate(5, 0), false); // zero goal never rainbows (guarded)
});

// --- Presence: chat/call time tracking ---------------------------------------

test("mergePresence prioritizes call > chat > idle", async () => {
  const { mergePresence } = await import("../detect.js");
  assert.equal(mergePresence(["idle", "chat", "call"]), "call");
  assert.equal(mergePresence(["idle", "chat", "idle"]), "chat");
  assert.equal(mergePresence(["idle", "idle"]), "idle");
  assert.equal(mergePresence([]), "idle");
});

test("presenceKind maps to away bucket", async () => {
  const { presenceKind } = await import("../detect.js");
  assert.equal(presenceKind("call"), "call");
  assert.equal(presenceKind("chat"), "chat");
  assert.equal(presenceKind("idle"), null);
});

test("addAway accumulates chat/call seconds per day", async () => {
  const { addAway, awayForDate } = await import("../detect.js");
  let away = {};
  away = addAway(away, "2026-07-14", "chat", 90);
  away = addAway(away, "2026-07-14", "call", 120);
  away = addAway(away, "2026-07-14", "chat", 30);
  const a = awayForDate(away, "2026-07-14");
  assert.equal(a.chatSec, 120);
  assert.equal(a.callSec, 120);
  assert.equal(a.totalSec, 240);
  assert.equal(a.chatMin, 2);
  assert.equal(a.totalMin, 4);
  // a different day is independent
  assert.equal(awayForDate(away, "2026-07-15").totalSec, 0);
});

test("addAway ignores idle/unknown kinds and non-positive seconds", async () => {
  const { addAway, awayForDate } = await import("../detect.js");
  let away = addAway({}, "2026-07-14", "idle", 100);
  away = addAway(away, "2026-07-14", "chat", 0);
  away = addAway(away, "2026-07-14", "chat", -5);
  assert.equal(awayForDate(away, "2026-07-14").totalSec, 0);
});

test("normalizeAway drops bad keys and clamps values", async () => {
  const { normalizeAway } = await import("../detect.js");
  const out = normalizeAway({
    "2026-07-14": { chatSec: 10.7, callSec: -3 },
    "not-a-date": { chatSec: 999 },
    "2026-07-15": "x",
  });
  assert.deepEqual(Object.keys(out), ["2026-07-14"]);
  assert.deepEqual(out["2026-07-14"], { chatSec: 10, callSec: 0 });
});

test("appendLog keeps a capped ring buffer (oldest dropped)", async () => {
  const { appendLog } = await import("../detect.js");
  let logs = [];
  for (let i = 0; i < 5; i++) logs = appendLog(logs, { ts: i, msg: String(i) }, 3);
  assert.equal(logs.length, 3);
  assert.deepEqual(logs.map((l) => l.msg), ["2", "3", "4"]);
});

test("formatLogsForExport renders a readable header + lines", async () => {
  const { formatLogsForExport } = await import("../detect.js");
  const text = formatLogsForExport(
    [{ ts: 0, level: "info", msg: "presence: idle -> call", detail: { tabs: 1 } }],
    { version: "1.10.0", away: { chatMin: 2, callMin: 5 } }
  );
  assert.match(text, /Ticket Telemetry — presence log export/);
  assert.match(text, /version: 1\.10\.0/);
  assert.match(text, /away today: chat 2m · call 5m/);
  assert.match(text, /presence: idle -> call/);
  assert.match(text, /\{"tabs":1\}/);
});
