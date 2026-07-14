// Verifies detection + counting against the three real Zendesk scenarios that
// were captured as HAR files (payloads reproduced below as fixtures).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deltaFromRequestBody,
  analyzeUpdateTicket,
  applyDelta,
  rollover,
  emptyState,
  badgeValue,
} from "../detect.js";

// --- Fixtures: minimal but faithful UpdateTicketMutation bodies ---------------

// Scenario 1: public reply, ticket moved to PENDING (not solved).
const publicReplyPending = JSON.stringify({
  operationName: "UpdateTicketMutation",
  variables: {
    id: "3397595",
    ticket: {
      status: "PENDING",
      customStatusId: "26099573796369",
      comment: { body: { value: "hello", format: "HTML" }, isPublic: true },
    },
  },
});

// Scenario 2: public reply AND solved in one submit.
const publicReplySolved = JSON.stringify({
  operationName: "UpdateTicketMutation",
  variables: {
    id: "3409874",
    ticket: {
      status: "SOLVED",
      customStatusId: "5540632",
      comment: { body: { value: "resolved", format: "HTML" }, isPublic: true },
    },
  },
});

// Scenario 3: internal note only (must not count).
const internalNote = JSON.stringify({
  operationName: "UpdateTicketMutation",
  variables: {
    id: "3409874",
    ticket: {
      comment: { body: { value: "note to self", format: "HTML" }, isPublic: false },
    },
  },
});

// A non-ticket GraphQL op that should be ignored entirely.
const unrelated = JSON.stringify({
  operationName: "SomethingElse",
  variables: { foo: "bar" },
});

// --- Detection tests ----------------------------------------------------------

test("public reply, not solved -> +1 reply only", () => {
  assert.deepEqual(deltaFromRequestBody(publicReplyPending), {
    replies: 1,
    solved: 0,
  });
});

test("public reply + solved -> +1 reply AND +1 solved (count both)", () => {
  assert.deepEqual(deltaFromRequestBody(publicReplySolved), {
    replies: 1,
    solved: 1,
  });
});

test("internal note -> counts nothing", () => {
  assert.deepEqual(deltaFromRequestBody(internalNote), {
    replies: 0,
    solved: 0,
  });
});

test("unrelated GraphQL operation is ignored", () => {
  assert.deepEqual(deltaFromRequestBody(unrelated), { replies: 0, solved: 0 });
});

test("solved with an internal note counts solved but not reply", () => {
  const body = JSON.stringify({
    operationName: "UpdateTicketMutation",
    variables: { ticket: { status: "SOLVED", comment: { isPublic: false } } },
  });
  assert.deepEqual(deltaFromRequestBody(body), { replies: 0, solved: 1 });
});

test("solved with no comment at all counts solved", () => {
  const body = JSON.stringify({
    operationName: "UpdateTicketMutation",
    variables: { ticket: { status: "SOLVED" } },
  });
  assert.deepEqual(deltaFromRequestBody(body), { replies: 0, solved: 1 });
});

test("batched request body (array) is handled", () => {
  const body = `[${publicReplySolved},${internalNote}]`;
  assert.deepEqual(deltaFromRequestBody(body), { replies: 1, solved: 1 });
});

test("malformed body does not throw", () => {
  assert.deepEqual(deltaFromRequestBody("not json"), { replies: 0, solved: 0 });
  assert.deepEqual(deltaFromRequestBody(""), { replies: 0, solved: 0 });
});

test("analyzeUpdateTicket handles missing ticket", () => {
  assert.deepEqual(analyzeUpdateTicket({}), {
    isPublicReply: false,
    isSolved: false,
  });
});

// --- Counting / rollover tests ------------------------------------------------

test("applyDelta accumulates today and all-time", () => {
  let s = emptyState("2026-07-14");
  s = applyDelta(s, { replies: 1, solved: 0 }, "2026-07-14");
  s = applyDelta(s, { replies: 1, solved: 1 }, "2026-07-14");
  assert.deepEqual(s.today, { replies: 2, solved: 1 });
  assert.deepEqual(s.total, { replies: 2, solved: 1 });
});

test("daily rollover resets today but preserves all-time", () => {
  let s = emptyState("2026-07-14");
  s = applyDelta(s, { replies: 3, solved: 2 }, "2026-07-14");
  const next = rollover(s, "2026-07-15");
  assert.deepEqual(next.today, { replies: 0, solved: 0 });
  assert.deepEqual(next.total, { replies: 3, solved: 2 });
  assert.equal(next.date, "2026-07-15");
});

test("applyDelta on a new day rolls over first", () => {
  let s = emptyState("2026-07-14");
  s = applyDelta(s, { replies: 5, solved: 4 }, "2026-07-14");
  s = applyDelta(s, { replies: 1, solved: 0 }, "2026-07-15");
  assert.deepEqual(s.today, { replies: 1, solved: 0 });
  assert.deepEqual(s.total, { replies: 6, solved: 4 });
});

test("badgeValue respects selected metric", () => {
  const s = applyDelta(emptyState("2026-07-14"), { replies: 3, solved: 2 }, "2026-07-14");
  assert.equal(badgeValue({ ...s, badgeMetric: "solved" }), 2);
  assert.equal(badgeValue({ ...s, badgeMetric: "replies" }), 3);
  assert.equal(badgeValue({ ...s, badgeMetric: "total" }), 5);
});

test("rollover normalizes partial/legacy stored state", () => {
  const s = rollover(undefined, "2026-07-14");
  assert.deepEqual(s.today, { replies: 0, solved: 0 });
  assert.deepEqual(s.total, { replies: 0, solved: 0 });
  assert.equal(s.badgeMetric, "solved");
});
