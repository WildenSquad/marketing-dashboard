# Claude Code prompt — marketing dashboard

Build me a self-contained marketing performance dashboard: a static HTML file
hosted on GitHub Pages, fed by a nightly GitHub Actions job that pulls from four
APIs and commits a `data.json` to the repo. I embed the Pages URL in Notion.

Work one step at a time. Don't scaffold everything at once — build the data
pipeline first against real credentials, confirm each source returns what we
expect, then build the UI against real data.

---

## Repo shape

```
/index.html          # the dashboard, single file, no build step, no dependencies
/data.json           # committed by the job; the system of record
/scripts/fetch.mjs   # the nightly fetcher (Node 20+, no deps beyond node:fetch)
/.github/workflows/refresh.yml
```

---

## Data contract — this is the important part

`data.json` is an array of daily rows, **raw counts only, never rates**:

```json
{ "date": "2026-07-30",
  "views": 0, "reach": 0, "reactions": 0, "comments": 0, "shares": 0,
  "followers": 0,
  "sessions": 0, "pageviews": 0, "conversions": 0,
  "subscribers": 0, "emails_delivered": 0, "emails_opened": 0, "emails_clicked": 0 }
```

Rates are derived at read time in the browser, never stored. Averaging seven
daily open rates does not give you the weekly open rate — the weekly rate is
`sum(opened) / sum(delivered)`. Same for engagement rate and conversion rate.
If you find yourself storing a percentage in `data.json`, you've made a mistake.

`followers` and `subscribers` are end-of-day snapshots (levels). Everything
else is a count for that day. Growth is derived as
`last_value_in_bucket − last_value_in_previous_bucket`.

**The file is the system of record, not the APIs.** Mailchimp's daily list
activity only reaches back 180 days; Meta's windows are shorter. Once a day
falls out of the source window, `data.json` is the only copy. The job must
never truncate history.

**Re-fetch a trailing 7-day window each run and overwrite those rows**, then
append beyond it. Buffer refreshes post metrics once daily and values can lag
the source network by ~24h, so appending yesterday once and never revisiting it
permanently freezes partial numbers. Merge by `date` key.

Backfill as far as each API allows on first run (Mailchimp 180 days, GA4 years,
Buffer up to its 365-day cap).

---

## Sources

### 1. Buffer — engagement (GraphQL)

Docs: https://developers.buffer.com/reference.html
Auth: personal API key, bearer token. Scopes needed: `postsRead`, `insightsRead`.
Note `insightsRead` is **not** available to OAuth App Clients — personal key only.

Use the `posts` query filtered by `sentAt`, selecting `metrics { type name value unit }`,
`sentAt`, `channelId`, `channelService`. Each post has one date and one channel,
so bucket to daily yourself.

**Do not use `aggregatedPostMetrics` across a mixed channel set.** It only returns
metrics that *every* channel in the filter supports, so a set spanning Instagram,
Facebook, LinkedIn and Bluesky collapses to just `postCount`, `reactions`, and
`comments`. Per-post gives daily granularity and full per-network metrics.

Metric names are cross-network normalized (`reactions`, `comments`, `shares`,
`reposts`, `reach`, `impressions`, `views`, `clicks`, `engagementRate`), with
network-specific extras (`saves`, `quotes`, `likes`). Handle missing metrics as
0, not as errors — networks differ in what they report.

Rate limits: 100 requests / 15 min, 250 / 24h (500 on Team plan), rolling.
A nightly job is nowhere near this, but respect 429s with backoff.

First calls: `account { organizations { id name } }`, then `channels(input:
{organizationId})` to get channel IDs. Print these — I need them for config.

### 2. Bluesky — follower count

`GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=<handle>`

Public, no auth, no token. Returns `followersCount`. This is a point-in-time
snapshot only — there's no historical series, so the nightly snapshot IS the
history. Start recording immediately.

### 3. Mailchimp — newsletter

Marketing API. Auth: API key + server prefix (the `usX` suffix on the key).

- Daily counts: list activity endpoint — up to 180 days of daily aggregated
  stats (sends, opens, clicks, subs, unsubs).
- Total subscribers: the list/audience object's member count.

Store `emails_delivered`, `emails_opened`, `emails_clicked` as raw counts.
Do not store Mailchimp's own `open_rate` field.

### 4. GA4 — website

Data API v1beta, `runReport`, service account auth (JSON key, base64-encoded
into a GitHub secret — never commit the file). The service account's
`client_email` needs Viewer on the GA4 property, added in the GA UI under
Admin → Property Access Management.

Dimension: `date`. Metrics: `sessions`, `screenPageViews`, `conversions`
(or your specific key-event metric — check what the property actually has
before assuming, and tell me if `conversions` isn't available).

---

## Metric naming: use Views, not Impressions

Meta consolidated impressions, Reel plays, and Story impressions into a single
**Views** metric across 2025–2026. Facebook page impressions were deprecated in
November 2025; only reach remains. Any tool still labeling this "impressions" is
relabeling Views data.

So: track **Views** (volume) and **Reach** (unique accounts), and calculate
engagement rate as `engagements / reach`, not against followers. If Buffer
returns an `impressions` type for a given channel, map it into `views`.

---

## Scheduling

GitHub Actions, `on: schedule`, daily. Two things to design around:

- Scheduled runs are best-effort and routinely drift 15–30 minutes late. Don't
  build anything that assumes precise timing.
- Scheduled workflows are **silently disabled after 60 days of repository
  inactivity**, and bot commits don't reliably reset that timer. Add a
  `workflow_dispatch` trigger so I can fire it manually, and make failures
  visible rather than silent.

Also add a step that fails loudly if any source returns zero rows — a silent
empty fetch that commits an unchanged file is the failure mode I'd never notice.

Secrets: `BUFFER_API_KEY`, `MAILCHIMP_API_KEY`, `MAILCHIMP_LIST_ID`,
`GA4_PROPERTY_ID`, `GA4_SERVICE_ACCOUNT` (base64), `BLUESKY_HANDLE`.

---

## The dashboard UI

Single `index.html`. No build step, no npm, no CDN dependencies, no localStorage.
Inline CSS and JS. Hand-rolled SVG for the chart — do not pull in a charting library.

- Fetches `./data.json` on load. Shows a clear message if it's missing or empty.
- **Timeframe toggle**: Daily / Weekly / Monthly / Yearly, switching aggregation
  of the whole view. Weeks are ISO (Monday start).
- **Date range picker**: two native `<input type="date">` bounded to the data
  range, plus 30d / 90d / 12mo / All presets.
- **Summary cards**, grouped by source: Social (Views, Engagement rate, Follower
  growth), Website (Sessions, Pageviews, Conversion rate), Newsletter
  (Subscribers, Open rate, CTR). Each card shows the value for the selected
  range and the change vs. the immediately preceding equal-length period —
  percentage change for counts, percentage-point change for rates.
- **One unified chart** below the cards, metric-switchable via chips. Bars for
  volume metrics, line for rates and levels.
- Notion's palette: `#37352f` on white, `#d4d4d4` on `#191919`. Detect OS theme,
  plus a manual toggle. Minimalist — hairline borders, 6px radius, tabular
  numerals on figures. Should look native inside a Notion page.
- Responsive to mobile, visible keyboard focus, `prefers-reduced-motion` respected.

---

## Order of work

1. Buffer org/channel discovery — print IDs, confirm `insightsRead` works.
2. Confirm which metric types each of my four channels actually returns.
3. Then the other three fetchers, one at a time.
4. Then merge logic + backfill.
5. Then the workflow.
6. Then the UI, against real `data.json`.

Stop and show me output after each. Don't guess at API response shapes — call
the API and look.
