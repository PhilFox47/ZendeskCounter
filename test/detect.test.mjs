// Verifies detection, productivity blocks, and per-day rates against the three
// real Zendesk scenarios (reproduced below as fixtures) plus edge cases.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deltaFromRequestBody,
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
  blockIndex,
  localDateKey,
  serializeState,
  parseImport,
  mergeStates,
  progressColor,
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

test("slotStatus: threshold boundary — just over stays 'go'", () => {
  // default threshold 5 min; at 13:24 there are 6 min left -> go
  assert.equal(slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 24)).status, "go");
  // at 13:25:00 exactly 5 min left -> wait (<= threshold)
  assert.equal(slotStatus(normalize(undefined), new Date(2026, 6, 14, 13, 25)).status, "wait");
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
