# Zendesk Ticket Counter

A Chrome extension (Manifest V3) that counts, per agent and per browser, how many
**public replies** you send and how many tickets you **submit as solved** in the
Zendesk Agent Workspace — and shows the running tally right on the toolbar icon.

## What it counts

Detection is based on the actual GraphQL mutation the Agent Workspace sends when
you submit a ticket (`POST /api/graphql`, operation `UpdateTicketMutation`),
confirmed against captured traffic:

| You did… | Payload signal | Counted as |
| --- | --- | --- |
| Public reply (any status short of solved) | `ticket.comment.isPublic === true` | **+1 public reply** |
| Submit as Solved (with a public reply) | `isPublic === true` **and** `status === "SOLVED"` | **+1 reply and +1 solved** |
| Submit as Solved (with an internal note / no comment) | `status === "SOLVED"` | **+1 solved** |
| Internal note only | `isPublic === false` | **nothing** |

A submit is only counted once the request completes with an HTTP 2xx, so
cancelled or failed submits never inflate the numbers.

## The badge and popup

- **Toolbar badge** — shows one number: today's *solved* count by default. Use the
  popup dropdown to switch it to *public replies* or *replies + solved*.
- **Hover tooltip** — shows both of today's numbers, e.g.
  `Zendesk today — Replies: 12 · Solved: 5`.
- **Popup** — shows today's replies/solved and all-time replies/solved, plus a
  reset button.

Counters roll over automatically at local midnight: "today" resets to zero while
the all-time totals keep accumulating.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a ticket in Zendesk and submit a reply — the badge updates.

By default the extension is scoped to `*.zendesk.com`. If your Agent Workspace
is on a vanity domain, add it to `host_permissions` in `manifest.json` and to the
three `chrome.webRequest.*.addListener` URL filters in `background.js`.

## Notes and limitations

- Counts are **local to this browser** (stored via `chrome.storage.local`) and
  begin at install — there is no historical back-fill and no sync across machines.
- Each solved submit increments the solved counter, including re-submitting an
  already-solved ticket.
- No page scripts are injected and no ticket content is read or stored — the
  extension only inspects the `isPublic` flag and `status` of your own submits.

## Development

```bash
npm test            # runs the detection/counting unit tests (node:test)
npm run gen-icons   # regenerates icons/ from tools/gen-icons.mjs
```

The detection and counting logic lives in `detect.js` (pure, no browser APIs) so
it can be tested in Node. `test/detect.test.mjs` exercises it against the three
real Zendesk scenarios plus edge cases.
