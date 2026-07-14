# Zendesk Productivity Tracker

A Chrome extension (Manifest V3) that turns your Zendesk Agent Workspace activity
into a productivity view: it counts **public replies** and **solved tickets**,
tracks **productive time in 30-minute blocks**, and reports your **replies-per-hour
and solved-per-hour** against targets — per day, on this browser.

## How productivity is measured

- **Productive block** — any 30-minute wall-clock block (`:00–:30`, `:30–:00`) in
  which you made *any* ticket submit: an internal note, a public reply, a solve,
  or a field change. A submit at 11:12 marks the **11:00–11:30** block productive.
- **Productive time** = number of productive blocks × 30 minutes.
- **Rates** = counts ÷ productive hours, compared to your targets
  (defaults: **7 public replies / hr**, **3 solved / hr** — editable in the popup).

## What counts as what

Detection is based on the actual GraphQL mutation the Agent Workspace sends on
submit (`POST /api/graphql`, operation `UpdateTicketMutation`), confirmed against
captured traffic:

| You did… | Payload signal | Effect |
| --- | --- | --- |
| Any ticket submit | operation `UpdateTicketMutation` | marks the current 30-min block **productive** |
| Public reply | `ticket.comment.isPublic === true` | **+1 public reply** |
| Submit as Solved | `ticket.status === "SOLVED"` | **+1 solved** |
| Internal note only | `isPublic === false` | productive block only (no reply/solve) |

A reply-and-solve in one submit counts as **both** +1 reply and +1 solved. A
submit is only counted once its request returns HTTP 2xx, so cancelled or failed
submits never inflate anything.

## The toolbar icon and popup

- **Toolbar icon** — the extension redraws its own icon to show today's two
  rates, stacked: **solved / hr on top, replies / hr below**, each to one
  decimal (e.g. `2.7` over `6.5`). Each number is **green** when it's at or
  above target and **amber** when it's below, so you can read your pace at a
  glance without opening anything. (Chrome's badge only fits ~4 characters, so
  the rates are drawn into the icon image itself rather than shown as badge
  text.)
- **Hover tooltip** — today's productive hours plus both counts and both rates.
- **Popup** —
  - **Today**: productive hours, active blocks, and the two per-hour rates with
    goal bars (green when the target is met, amber when not).
  - **By day**: a table of every recorded day with productive hours, counts, and
    per-hour rates, each rate colored by whether it hit target.
  - **Settings**: editable targets, backup (export / import), and reset-all.

## Backup: export & import

Your data lives only in this browser, so the popup's **Backup** row lets you move
it across versions or devices:

- **Export** downloads a small `zendesk-productivity-YYYY-MM-DD.json` file
  containing every recorded day and your targets. It's a plain, versioned,
  self-describing JSON envelope (`{ app, schema, exportedAt, data }`) — no ticket
  content, just the counts, 30-minute-block indices, and goals.
- **Import · replace** overwrites all current data with the file's data
  (including its targets). Use this to restore, or to seed a fresh install.
- **Import · merge** combines the file into what you already have: non-overlapping
  days are added, and for a day present in both it keeps the **higher** reply and
  solved counts and **unions** the productive blocks. Your current targets are
  left unchanged. (Merge is intended for combining a clean export into an empty or
  partial install; because overlapping days take the max rather than the sum, it
  won't double-count a day you re-import.)

Imported files are validated and sanitized: non-JSON or non-tracking files are
rejected, unknown/oddly-shaped entries are dropped, and counts/blocks/targets are
clamped to sane values.

Days are kept separately; each new local day starts fresh while history is
retained.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open a ticket in Zendesk and submit — the badge and popup update.

By default the extension is scoped to `*.zendesk.com`. For a vanity workspace
domain, add it to `host_permissions` in `manifest.json` and to the three
`chrome.webRequest.*.addListener` URL filters in `background.js`.

## Notes and limitations

- All data is **local to this browser** (`chrome.storage.local`) and starts at
  install — no historical back-fill, no cross-machine sync.
- "Activity" is a ticket **submit**. Reading tickets, typing without submitting,
  or navigating are not observable as submits and do not mark a block productive.
- Each solved submit increments solved, including re-submitting an already-solved
  ticket.
- No page scripts are injected and no ticket content is read or stored — only the
  `isPublic` flag and `status` of your own submits, plus submit timestamps.

## Development

```bash
npm test            # detection + productivity/rate unit tests (node:test)
npm run gen-icons   # regenerate icons/ from tools/gen-icons.mjs
```

Pure logic (detection, block/rate math, per-day state) lives in `detect.js` with
no browser APIs, so it is unit-tested in Node. `test/detect.test.mjs` covers the
three real Zendesk scenarios plus block indexing, rates, per-day separation,
badge, and legacy-state migration.
