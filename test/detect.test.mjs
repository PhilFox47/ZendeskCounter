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
  badgeValue,
  badgeText,
  blockIndex,
  localDateKey,
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

// --- Badge -------------------------------------------------------------------

test("badge reflects selected metric including productive hours", () => {
  let s = normalize(undefined);
  const now = new Date();
  s = applyActivity(s, { replies: 3, solved: 2, activity: true }, now);
  const key = localDateKey(now);
  const m = metricsForDate(s, key);
  assert.equal(m.productiveHours, 0.5);
  assert.equal(badgeValue({ ...s, badgeMetric: "solved" }), 2);
  assert.equal(badgeValue({ ...s, badgeMetric: "replies" }), 3);
  assert.equal(badgeValue({ ...s, badgeMetric: "total" }), 5);
  assert.equal(badgeValue({ ...s, badgeMetric: "productive" }), 0.5);
  assert.equal(badgeText({ ...s, badgeMetric: "productive" }), "0.5");
  assert.equal(badgeText({ ...s, badgeMetric: "solved" }), "2");
});

test("badge is empty when zero", () => {
  assert.equal(badgeText(normalize(undefined)), "");
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
  assert.equal(s.badgeMetric, "replies");
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
