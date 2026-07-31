# Ticket Telemetry

*Your Zendesk productivity, at a glance.*

A Chrome extension (Manifest V3) that turns your Zendesk Agent Workspace activity
into a productivity view: it counts **public replies** and **solved tickets**,
tracks **productive time in 30-minute blocks**, and reports your **replies-per-hour
and solved-per-hour** against targets — per day, on this browser. It shows your
current pace right on the toolbar icon, and a full **timeline dashboard** for the
detail.

## How productivity is measured

- **Productive block** — any 30-minute wall-clock block (`:00–:30`, `:30–:00`) in
  which you made *any* ticket submit: an internal note, a public reply, a solve,
  or a field change. A submit at 11:12 marks the **11:00–11:30** block productive.
- **Productive time** = number of productive blocks × 30 minutes.
- **Rates** = counts ÷ productive hours, compared to your targets
  (defaults: **7 public replies / hr**, **3 solved / hr** — editable in the popup).

## What counts as what

Detection is based on the actual requests the Agent Workspace sends, confirmed
against captured traffic. Ticket **updates** and **independent new tickets** go
through GraphQL mutations (`POST /api/graphql` — `UpdateTicketMutation` and
`CreateIssueTicketMutation`, which share the same ticket shape); a new ticket
started from a **side conversation** goes through the REST API
(`POST /api/v2/tickets.json`):

| You did… | Payload signal | Effect |
| --- | --- | --- |
| Any ticket submit / create | `UpdateTicketMutation`, `CreateIssueTicketMutation`, or REST create | marks the current 30-min block **productive** |
| Public reply | `ticket.comment.isPublic === true` | **+1 public reply** |
| Submit as Solved | `ticket.status === "SOLVED"` | **+1 solved** |
| Internal note only | `isPublic === false` | productive block only (no reply/solve) |
| **New independent ticket** | `CreateIssueTicketMutation` (same shape) | **+1 public reply** and, if solved, **+1 solved** |
| **New ticket via side conversation** | REST create, `comment.public !== false` | **+1 public reply** (its first comment is public by default) |

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
  glance without opening anything. Values below 10 show one decimal (`6.5`); at
  10 and above they drop the decimal (`10`, `13`) so the digits stay large
  instead of shrinking to fit `10.0`. (Chrome's badge only fits ~4 characters,
  so the rates are drawn — large — into the icon image itself rather than shown
  as badge text.)
- **Hover tooltip** — today's productive hours plus both counts and both rates.
- **Popup** —
  - **Act now?**: a live indicator at the top advising whether this is a good
    moment to handle a ticket, from a block-efficiency angle. **Green** if the
    current 30-min block already has activity ("keep going, it's counted") or is
    idle with plenty of time left ("good time to start"); **amber** if the block
    is idle and nearly over ("maybe wait ~N min for a fresh block, rather than
    spending a whole block on a couple of minutes"). It updates on a timer and
    whenever a submit lands. The warning appears when **fewer than 15 minutes**
    would be left in the block if you started now (`SLOT_WAIT_THRESHOLD_MIN`).
  - **Today**: productive hours, active blocks, and the two per-hour rates with
    goal bars (green when the target is met, amber when not).
  - **By day**: a table of every recorded day with productive hours, counts, and
    per-hour rates, each rate colored by whether it hit target.
  - **Settings**: editable targets, backup (export / import), and reset-all.
  - **Open dashboard ↗**: opens the full-page timeline view (below).

## The dashboard (timeline)

Click **Open dashboard ↗** in the popup (or use the extension's *Options* entry)
to open a full browser tab with the detailed view:

- **Activity Timeline** — the selected day is split into 48 half-hour blocks
  (00:00–24:00), shown as two rows: **Solved** and **Replies**. Each active block
  is filled with the same red→amber→green→purple color for how your pace in that
  30 minutes compares to target (a block of *N* = *N × 2* per hour), and shows the
  count. Hover any block for the exact time, count, and rate. Inactive blocks stay
  empty; a block you were active in but scored 0 on that metric reads red.
- **Summary cards** — productive time, solved/hr, replies/hr (colored), and your
  best single 30-minute rate of the day.
- **Recent days** — the last two weeks, each day a compact pair of mini timeline
  strips with its day rates; click one to load it into the timeline. Day-nav
  arrows and a date picker move between days.

Toggle **Day / Week** in the header to switch to weekly reports:

- Weeks are **calendar work weeks (Monday–Friday)**, not a rolling 7 days.
  Saturday/Sunday activity is excluded from weekly figures (it still shows in the
  daily view).
- **Week summary** — productive time, solved/hr and replies/hr for the week
  (over the week's total productive hours), and how many of the 5 weekdays you
  were active.
- **Mon–Fri breakdown** — one row per weekday with its mini timelines and rates;
  click a weekday to jump to its daily view. Rest days are marked.
- **Recent weeks** — each past week as a Mon–Fri heat strip with its week rates;
  click to open it.

The dashboard reads the same local data — no network, nothing new stored.

> 🌈 Easter egg: a single block above **333%** of its goal (e.g. 6+ solves or
> 12+ replies in one 30 minutes) skips purple and gets an animated rainbow fill —
> a little bonus for an especially strong split. (Honours `prefers-reduced-motion`.)

> Per-block detail exists from **v1.4** onward. Days recorded before that (or
> imported from an older export) still show *when* you were active, just without
> the per-block breakdown (those blocks render neutral grey).

## Active chat / phone time (auto-detected)

Time spent in a live chat or on a call is *not* ticket-handling time, so the
extension auto-detects it via a **content script** on the Zendesk agent workspace
(`*://*.zendesk.com/agent/*`). It reads only page state — never ticket content —
and reports a coarse status to the background worker, which times it.

- **Active chat** — detected when a ticket tab shows a **green status bubble**
  (`[data-test-id="header-tab"]` with a green `avatars.status_indicator`).
- **On a call** — detected from the in-call control elements that only exist
  during a live call (`talk-agent-status-call-timer`, `ticket-call-controls-hang-up`,
  `ticket-call-controls-mute`, `call-control-buttons-container`). These are
  language-independent; the `talk-top-nav-control-*` suffix is **not** used for
  this because it reads `online` both when available and on a call.
- Merged across tabs (**call > chat > idle**) and accumulated per day as chat/call
  seconds. A live **status indicator** in the popup shows the current state and
  today's chat/call minutes. The **dashboard** shows it too: a "Chat / call" card
  in both the day and week summaries, plus a per-weekday chat/call note in the
  week breakdown.

**Troubleshooting logs.** Because the exact DOM states vary, the extension keeps a
capped log of detections and state changes. The popup's **Diagnostics → Export
logs** saves them (with the raw signals — tab statuses, colors, Talk state) to a
text file you can share, and **Clear logs** resets it. This is how the green /
on-call thresholds get calibrated if something is mis-detected.

### Deducted from productive time

Chat/call time is **deducted from productive time**, so your solved/hr and
replies/hr are measured over ticket-available time. The deduction is **per
block**: only chat/call seconds that fall *within a productive 30-minute block*
are removed (a block's productive portion = 30 min − chat/call in that block,
floored at 0). Time on a call during a block where you did *no* ticket work isn't
subtracted — there was no productive time there to remove — so the rate can't be
distorted by out-of-band calls. The deduction flows through everywhere: the
toolbar icon rates, the popup ("Productive hours (−Nm)" and the By-day table), and
the dashboard day/week summaries.

> Detection note: the green-bubble / on-call thresholds are still heuristics that
> may need calibration — use the exported logs above if something is mis-detected.
> (Network detection isn't possible here: chat runs over a WebSocket and Talk over
> WebRTC, neither readable by the extension — hence the DOM approach.)

## Backup: export & import

Your data lives only in this browser, so the popup's **Backup** row lets you move
it across versions or devices:

- **Export** downloads a small `zendesk-productivity-YYYY-MM-DD.json` file
  containing every recorded day, your targets, and per-day chat/call time. It's a
  plain, versioned, self-describing JSON envelope
  (`{ app, schema, exportedAt, data: { days, goals, away } }`) — no ticket
  content, just the counts, 30-minute-block indices, goals, and chat/call seconds.
  (Chat/call time also merges on import, taking the higher per-day value.)
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
