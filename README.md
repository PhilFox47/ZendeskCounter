# Ticket Telemetry

*Live timing for your Zendesk support laps.*

A Chrome extension (Manifest V3) that turns your Zendesk Agent Workspace activity
into a productivity view: it counts **public replies** and **solved tickets**,
tracks **productive time in 30-minute blocks**, and reports your **replies-per-hour
and solved-per-hour** against targets — per day, on this browser. It shows your
current pace right on the toolbar icon, and a full **sector-timing dashboard**
(F1-style) for the detail.

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

### Known limitation: automatic solves aren't counted

The extension only sees actions **you** perform in this browser. Tickets that
Zendesk solves **automatically** — e.g. a pending ticket closed by a "solve after
N days" automation when the customer never replies — are solved **server-side**,
with no browser activity to observe, so they are **not counted** here.

Practical effect: for solved tickets, this extension can read **lower** than your
company's own Zendesk report, by exactly the number of your tickets that
auto-solved. This is a deliberate trade-off: counting auto-solves would require
the extension to actively poll the Zendesk API for your ticket data (it currently
makes no network calls and reads nothing but your own submit flags), and those
solves carry no productive time, so they'd distort the solved/hr rate. If you ever
want them tracked as a separate opt-in stat, that's a feasible addition.

## The toolbar icon and popup

- **Toolbar icon** — the extension redraws its own icon to show today's two
  rates, stacked: **solved / hr on top, replies / hr below**, each to one
  decimal (e.g. `2.7` over `6.5`). Each number is **colored by its progress to
  target**, smoothly: **red** at 0% → **amber** at 50% → **green** at 100%, then
  it stays solid green up to 150%, and turns **purple** at 150%+ (overachieving).
  The two numbers are colored independently, so you can read your pace at a
  glance without opening anything. (Chrome's badge only fits ~4 characters, so
  the rates are drawn — large — into the icon image itself rather than shown as
  badge text.)
- **Hover tooltip** — today's productive hours plus both counts and both rates.
- **Popup** —
  - **Today**: productive hours, active blocks, and the two per-hour rates with
    goal bars (green when the target is met, amber when not).
  - **By day**: a table of every recorded day with productive hours, counts, and
    per-hour rates, each rate colored by whether it hit target.
  - **Settings**: editable targets, backup (export / import), and reset-all.
  - **Open dashboard ↗**: opens the full-page sector-timing view (below).

## The dashboard (sector timing)

Click **Open dashboard ↗** in the popup (or use the extension's *Options* entry)
to open a full browser tab styled after an F1 sector-timing board:

- **Sector Timing** — the selected day is split into 48 half-hour "sectors"
  (00:00–24:00), shown as two tracks: **Solved** and **Replies**. Each active
  sector is filled with the same red→amber→green→purple color for how your pace
  in that 30 minutes compares to target (a block of *N* = *N × 2* per hour), and
  shows the count. Hover any sector for the exact time, count, and rate. Inactive
  sectors stay empty; a sector you were active in but scored 0 on that metric
  reads red.
- **Summary cards** — productive time, solved/hr, replies/hr (colored), and your
  best single 30-minute pace of the day.
- **Recent laps** — the last two weeks, each day a compact pair of mini sector
  strips with its day rates; click one to load it into the board. Day nav arrows
  and a date picker move between days.

The dashboard reads the same local data — no network, nothing new stored.

> Per-sector detail exists from **v1.4** onward. Days recorded before that (or
> imported from an older export) still show *when* you were active, just without
> the per-sector breakdown (those blocks render neutral grey).

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
