#!/usr/bin/env node
/**
 * fetch.mjs — nightly marketing data refresh
 *
 * Node 20+. No dependencies. Run: node scripts/fetch.mjs
 *
 * Reads data.json, fetches a trailing window from each source, merges by date,
 * writes data.json back. History is never truncated — this file is the system
 * of record, because the upstream APIs age data out (Mailchimp ~180 days,
 * Meta shorter, Bluesky has no history at all).
 *
 * CONTRACT: raw counts only. Never store a rate. Rates are derived in the
 * browser so they stay correct at every aggregation level.
 */

import { readFile, writeFile } from "node:fs/promises";
import { createSign } from "node:crypto";
import { pathToFileURL } from "node:url";

const DATA_PATH = new URL("../data.json", import.meta.url);

/* Trailing window to re-fetch and overwrite on every run.
   Buffer refreshes post metrics once daily and can lag the source network by
   ~24h, so yesterday's numbers are provisional. 7 days is cheap insurance. */
const REFRESH_DAYS = 7;

/* First run only: how far back to reach. Each source clamps to its own limit. */
const BACKFILL_DAYS = 400;

const env = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing required env var: ${k}`);
  return v;
};

/* ------------------------------------------------------------------ *
 * date helpers — everything is a UTC 'YYYY-MM-DD' string
 * ------------------------------------------------------------------ */
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
const eachDay = (from, to) => {
  const out = [], d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z");
  while (d <= end) { out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
};

/* ------------------------------------------------------------------ *
 * row shape — every field a raw count; followers/subscribers are levels
 * ------------------------------------------------------------------ */
const COUNT_FIELDS = [
  "views", "reach", "reactions", "comments", "shares",
  "reach_engagements",
  "sessions", "pageviews", "conversions",
  "emails_delivered", "emails_opened", "emails_clicked",
];
const LEVEL_FIELDS = ["followers", "subscribers"];

const emptyRow = (date) => {
  const r = { date };
  for (const f of COUNT_FIELDS) r[f] = 0;
  for (const f of LEVEL_FIELDS) r[f] = null; // null = unknown, distinct from 0
  return r;
};

/* ------------------------------------------------------------------ *
 * fetch helper with retry/backoff — Buffer returns 429 on rate limit
 * ------------------------------------------------------------------ */
async function request(url, opts = {}, attempt = 1) {
  const res = await fetch(url, opts);
  if (res.status === 429 || res.status >= 500) {
    if (attempt > 4) throw new Error(`${url} failed: ${res.status} after ${attempt} attempts`);
    const wait = 2 ** attempt * 1000;
    console.warn(`  ${res.status} — retrying in ${wait}ms (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, wait));
    return request(url, opts, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} failed: ${res.status} ${await res.text()}`);
  return res;
}

/* ================================================================== *
 * SOURCE 1 — Buffer (GraphQL). Engagement metrics, bucketed by sentAt.
 *
 * TODO(claude-code): confirm the GraphQL endpoint URL from
 *   https://developers.buffer.com/guides/authentication.html
 *   (the docs reference it; it is NOT graphql.buffer.com by assumption).
 *
 * Scopes: postsRead + insightsRead. insightsRead is personal-API-key only —
 * OAuth App Clients cannot read analytics.
 *
 * DO NOT use aggregatedPostMetrics here. Across a mixed channel set it only
 * returns metrics every channel supports, collapsing IG+FB+LinkedIn+Bluesky
 * down to postCount/reactions/comments. Per-post keeps full per-network
 * metrics and gives daily granularity for free.
 * ================================================================== */
const BUFFER_ENDPOINT = "https://api.buffer.com";

export async function bufferQuery(query, variables) {
  const res = await request(BUFFER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env("BUFFER_API_KEY")}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(`Buffer GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/** Step 1 of the build: run this alone, print the IDs, put them in env. */
export async function bufferDiscover() {
  const data = await bufferQuery(`
    query {
      account {
        organizations { id name }
      }
    }
  `);
  return data.account.organizations;
}

export async function bufferChannels(organizationId) {
  const data = await bufferQuery(`
    query($input: ChannelsInput!) {
      channels(input: $input) { id name service type isDisconnected }
    }
  `, { input: { organizationId } });
  return data.channels;
}

/**
 * Map Buffer's normalized metric types onto our row fields.
 * Buffer normalizes across networks (IG likes -> reactions, X retweets ->
 * reposts) but networks still differ in what they report. Missing = 0.
 *
 * Note: Meta folded impressions/plays/story-impressions into a single Views
 * metric across 2025-26, so `impressions` is mapped into `views` rather than
 * tracked separately.
 */
const BUFFER_METRIC_MAP = {
  reach: "reach",
  reactions: "reactions",
  likes: "reactions",
  comments: "comments",
  shares: "shares",
  reposts: "shares",
  // views/impressions are handled separately — see postViews(). Mapping both
  // here would double-count LinkedIn video posts, which return BOTH.
  //
  // engagementRate is a RATE — deliberately not stored. Derived in the browser
  // from reach_engagements / reach.
  //
  // Deliberately unmapped, confirmed present in step 2:
  //   saves, clicks  — only Instagram / only Facebook. Folding them into
  //                    engagements would make channels non-comparable.
  //   follows        — a per-post follower GAIN (a count). `followers` is a
  //                    level; mixing them corrupts the carry-forward.
  //   viewers, totalTimeWatched, quotes, postCount — not in the row schema.
};

/* Engagement actions, for the reach-matched denominator below. */
const ENGAGEMENT_TYPES = new Set(["reactions", "likes", "comments", "shares", "reposts"]);

/**
 * Views for one post, from its metric list.
 *
 * Step 2 on the real channel set: Instagram returns `views` only, Facebook
 * `impressions` only, LinkedIn returns `impressions` on every post AND `views`
 * on video posts. Meta folded impressions into Views across 2025-26, so the two
 * name the same thing — summing them inflates LinkedIn video days. Prefer the
 * post's own `views`, fall back to `impressions`.
 */
function postViews(metrics) {
  let views = null, impressions = null;
  for (const m of metrics) {
    if (m.unit && m.unit !== "count") continue;
    if (m.type === "views") views = (views ?? 0) + (m.value ?? 0);
    else if (m.type === "impressions") impressions = (impressions ?? 0) + (m.value ?? 0);
  }
  return views ?? impressions ?? 0;
}

export async function fetchBuffer(from, to) {
  const organizationId = env("BUFFER_ORG_ID");
  const byDate = new Map();
  let after = null, page = 0;

  do {
    // TODO(claude-code): verify field names against the schema before trusting
    // this. `posts` takes (input, first, after) and returns a Relay connection.
    const data = await bufferQuery(`
      query($input: PostsInput!, $first: Int, $after: String) {
        posts(input: $input, first: $first, after: $after) {
          edges {
            node {
              id sentAt channelService status
              metrics { type value unit }
            }
            cursor
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, {
      input: {
        organizationId,
        filter: {
          status: ["sent"],
          dueAt: { start: `${from}T00:00:00Z`, end: `${to}T23:59:59Z` },
        },
      },
      first: 100,
      after,
    });

    for (const { node } of data.posts.edges ?? []) {
      if (!node.sentAt) continue;
      const date = node.sentAt.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, {});
      const bucket = byDate.get(date);
      const metrics = node.metrics ?? [];

      const add = (field, value) => { bucket[field] = (bucket[field] ?? 0) + value; };

      add("views", postViews(metrics));

      /* Engagements from THIS post, and whether this post reported reach.
         Only two of the four channels return reach (step 2: Instagram and
         LinkedIn do, Facebook and Bluesky don't). Dividing all-channel
         engagements by two-channel reach overstated the rate by 24% on the
         real year of data — so accumulate a denominator-matched numerator
         alongside the raw totals. Both are counts; the contract holds. */
      let engagements = 0, hasReach = false;

      for (const m of metrics) {
        if (m.unit && m.unit !== "count") continue;  // never sum a percentage
        const field = BUFFER_METRIC_MAP[m.type];
        if (!field) continue;                        // rates and unmapped types skipped
        const value = m.value ?? 0;
        add(field, value);
        if (m.type === "reach") hasReach = true;
        if (ENGAGEMENT_TYPES.has(m.type)) engagements += value;
      }

      if (hasReach) add("reach_engagements", engagements);
    }

    after = data.posts.pageInfo?.hasNextPage ? data.posts.pageInfo.endCursor : null;
    if (++page > 50) throw new Error("Buffer pagination runaway — check the filter");
  } while (after);

  return byDate; // Map<'YYYY-MM-DD', {views, reach, reactions, ...}>
}

/* ================================================================== *
 * SOURCE 2 — Bluesky. Follower count only. Public, no auth.
 *
 * There is no historical series here. Today's snapshot IS the history —
 * which is exactly why data.json must never be rebuilt from scratch.
 * ================================================================== */
export async function fetchBlueskyFollowers() {
  const handle = env("BLUESKY_HANDLE");
  const res = await request(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`
  );
  const profile = await res.json();
  return { date: iso(new Date()), followers: profile.followersCount ?? null };
}

/* ================================================================== *
 * SOURCE 3 — Mailchimp. Daily list activity + current member count.
 *
 * Field names confirmed against the live endpoint: day, emails_sent,
 * unique_opens, recipient_clicks, hard_bounce, soft_bounce, subs, unsubs,
 * other_adds, other_removes. Returned newest-first.
 *
 * `count` is a hard row cap, not a day count — count=180 returns 180 ROWS,
 * which on this list reached back to 2025-04-10. Ask for more than exists
 * (the API caps out on its own) rather than assuming 180 days.
 *
 * Coverage is contiguous over the recent window and sparse further back:
 * days with no activity at all are simply absent, so a missing day is a
 * genuine zero, not a hole.
 * ================================================================== */
export async function fetchMailchimp(from, to) {
  const key = env("MAILCHIMP_API_KEY");
  const listId = env("MAILCHIMP_LIST_ID");
  const dc = key.split("-")[1];               // key suffix is the server prefix
  if (!dc) throw new Error("MAILCHIMP_API_KEY missing its -usX server suffix");
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const auth = "Basic " + Buffer.from(`anystring:${key}`).toString("base64");

  const activityRes = await request(
    `${base}/lists/${listId}/activity?count=1000`,
    { headers: { Authorization: auth } }
  );
  const { activity = [] } = await activityRes.json();

  const byDate = new Map();
  for (const day of activity) {
    const date = (day.day ?? "").slice(0, 10);
    if (!date || date < from || date > to) continue;
    // Delivered, not sent: bounces never reached an inbox, so counting them
    // in the denominator would understate the open rate.
    const sent = day.emails_sent ?? 0;
    const bounced = (day.hard_bounce ?? 0) + (day.soft_bounce ?? 0);
    byDate.set(date, {
      emails_delivered: Math.max(0, sent - bounced),
      emails_opened: day.unique_opens ?? 0,
      emails_clicked: day.recipient_clicks ?? 0,
    });
  }

  // Current total subscribers — a level, applies to today only.
  //
  // Not reconstructed backwards from the daily subs/unsubs deltas, though it
  // looks tempting: those deltas sum to +829 over the returned window while
  // member_count is 272, so walking back from today would go negative within
  // the year. The deltas don't reconcile against the member count (cleaned
  // addresses and admin edits aren't fully represented), so the honest series
  // starts today and grows from here — same as Bluesky.
  const listRes = await request(`${base}/lists/${listId}`, { headers: { Authorization: auth } });
  const list = await listRes.json();
  const today = iso(new Date());
  byDate.set(today, {
    ...(byDate.get(today) ?? {}),
    subscribers: list.stats?.member_count ?? null,
  });

  return byDate;
}

/* ================================================================== *
 * SOURCE 4 — GA4 Data API v1beta, service account auth.
 *
 * GA4_SERVICE_ACCOUNT is the JSON key file, base64-encoded. Never commit the
 * raw file. The service account's client_email needs Viewer on the property
 * (GA UI -> Admin -> Property Access Management).
 * ================================================================== */
async function googleAccessToken() {
  const creds = JSON.parse(
    Buffer.from(env("GA4_SERVICE_ACCOUNT"), "base64").toString("utf8")
  );
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");

  const claim = b64({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  });
  const header = b64({ alg: "RS256", typ: "JWT" });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(creds.private_key, "base64url");
  const jwt = `${header}.${claim}.${signature}`;

  const res = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  return (await res.json()).access_token;
}

export async function fetchGA4(from, to) {
  const token = await googleAccessToken();
  const propertyId = env("GA4_PROPERTY_ID");

  // `conversions` does NOT exist on this property — checked against the
  // metadata endpoint, which lists 89 metrics and no `conversions` among them.
  // GA4 renamed it to `keyEvents`. Stored in our `conversions` field, which is
  // the dashboard's name for it.
  const res = await request(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate: from, endDate: to }],
        dimensions: [{ name: "date" }],
        metrics: [
          { name: "sessions" },
          { name: "screenPageViews" },
          { name: "keyEvents" },
        ],
        limit: 100000,
      }),
    }
  );
  const json = await res.json();

  const byDate = new Map();
  for (const row of json.rows ?? []) {
    const raw = row.dimensionValues[0].value;          // 'YYYYMMDD'
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    byDate.set(date, {
      sessions: Number(row.metricValues[0].value) || 0,
      pageviews: Number(row.metricValues[1].value) || 0,
      conversions: Number(row.metricValues[2].value) || 0,
    });
  }
  return byDate;
}

/* ================================================================== *
 * MERGE — the part that must not have bugs
 * ================================================================== */
function merge(existing, incoming, from, to) {
  const index = new Map(existing.map((r) => [r.date, r]));

  // Only dates inside the refresh window get overwritten. Everything older is
  // untouchable — the source APIs can no longer confirm it.
  for (const date of eachDay(from, to)) {
    const row = { ...emptyRow(date), ...(index.get(date) ?? {}) };
    for (const source of incoming) {
      const patch = source.get(date);
      if (!patch) continue;
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) continue;
        row[k] = v;
      }
    }
    index.set(date, row);
  }

  // Carry levels forward across gaps: a day with no snapshot inherits the last
  // known value rather than reading as a drop to zero.
  const rows = [...index.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const field of LEVEL_FIELDS) {
    let last = null;
    for (const row of rows) {
      if (row[field] === null || row[field] === undefined) row[field] = last;
      else last = row[field];
    }
  }
  return rows;
}

/* ================================================================== *
 * MAIN
 * ================================================================== */
async function main() {
  let existing = [];
  try {
    existing = JSON.parse(await readFile(DATA_PATH, "utf8"));
    if (!Array.isArray(existing)) throw new Error("data.json is not an array");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    console.log("No data.json — treating this as a first run.");
  }

  const firstRun = existing.length === 0;
  const from = daysAgo(firstRun ? BACKFILL_DAYS : REFRESH_DAYS);
  const to = iso(new Date());
  console.log(`Window: ${from} -> ${to}${firstRun ? " (backfill)" : ""}`);

  const sources = [];
  const failures = [];

  for (const [name, fn] of [
    ["buffer", () => fetchBuffer(from, to)],
    ["mailchimp", () => fetchMailchimp(from, to)],
    ["ga4", () => fetchGA4(from, to)],
    ["bluesky", async () => {
      const { date, followers } = await fetchBlueskyFollowers();
      return new Map([[date, { followers }]]);
    }],
  ]) {
    try {
      const result = await fn();
      console.log(`  ${name}: ${result.size} days`);
      if (result.size === 0) failures.push(`${name} returned zero rows`);
      sources.push(result);
    } catch (err) {
      failures.push(`${name}: ${err.message}`);
      console.error(`  ${name} FAILED — ${err.message}`);
    }
  }

  // A silent empty fetch that commits an unchanged file is the failure mode
  // you'd never notice. Make it loud, but still write what did succeed.
  const merged = merge(existing, sources, from, to);
  await writeFile(DATA_PATH, JSON.stringify(merged, null, 0) + "\n");
  console.log(`Wrote ${merged.length} rows (${merged[0]?.date} -> ${merged.at(-1)?.date})`);

  if (failures.length) {
    console.error("\nFailures:\n  " + failures.join("\n  "));
    process.exit(1);
  }
}

/* Compare URL to URL. `file://${process.argv[1]}` never matches on Windows,
   where argv[1] is a drive path — main() would silently not run and the job
   would exit 0 having fetched nothing. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exitCode = 1; });
}
