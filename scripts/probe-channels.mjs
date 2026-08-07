#!/usr/bin/env node
/**
 * probe-channels.mjs — step 2: what does each channel actually report?
 *
 * Run: node --env-file=.env scripts/probe-channels.mjs
 *
 * Read-only. Pages the full 365-day window and tallies, per channel service,
 * which PostMetricType values appear, how often, and their totals. A metric
 * absent here is genuinely absent, not just missing from a small sample.
 */

import { bufferQuery } from "./fetch.mjs";

const DAYS = 365;
const orgId = process.env.BUFFER_ORG_ID;
if (!orgId) throw new Error("BUFFER_ORG_ID not set — run discover-buffer.mjs first");

const iso = (d) => d.toISOString().slice(0, 10);
const end = new Date();
const start = new Date();
start.setUTCDate(start.getUTCDate() - DAYS);

const QUERY = `
  query($input: PostsInput!, $first: Int, $after: String) {
    posts(input: $input, first: $first, after: $after) {
      edges { node { id sentAt channelId channelService metrics { type value unit } } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const input = {
  organizationId: orgId,
  filter: {
    status: ["sent"],
    dueAt: { start: `${iso(start)}T00:00:00Z`, end: `${iso(end)}T23:59:59Z` },
  },
};

/* service -> { posts, dates:Set, metrics: Map<type, {unit, n, total}> } */
const byService = new Map();
let after = null, page = 0, total = 0, earliest = null, latest = null;

do {
  const data = await bufferQuery(QUERY, { input, first: 100, after });
  const edges = data.posts?.edges ?? [];
  for (const { node } of edges) {
    total++;
    const svc = node.channelService ?? "?";
    if (!byService.has(svc)) byService.set(svc, { posts: 0, dates: new Set(), metrics: new Map() });
    const s = byService.get(svc);
    s.posts++;
    if (node.sentAt) {
      const d = node.sentAt.slice(0, 10);
      s.dates.add(d);
      if (!earliest || d < earliest) earliest = d;
      if (!latest || d > latest) latest = d;
    }
    for (const m of node.metrics ?? []) {
      if (!s.metrics.has(m.type)) s.metrics.set(m.type, { unit: m.unit, n: 0, total: 0 });
      const e = s.metrics.get(m.type);
      e.n++;
      if (m.unit === "count") e.total += m.value ?? 0;
    }
  }
  after = data.posts?.pageInfo?.hasNextPage ? data.posts.pageInfo.endCursor : null;
  if (++page > 50) throw new Error("pagination runaway");
} while (after);

console.log(`\nWindow ${iso(start)} -> ${iso(end)}  |  ${total} sent posts across ${page} page(s)`);
console.log(`Actual post dates span ${earliest} -> ${latest}\n`);

const ALL = [...new Set([...byService.values()].flatMap((s) => [...s.metrics.keys()]))].sort();

/* presence matrix */
const services = [...byService.keys()].sort();
const w = Math.max(...ALL.map((m) => m.length)) + 2;
console.log("PRESENCE (metric x channel; . = never returned)\n");
console.log("  " + "".padEnd(w) + services.map((s) => s.padEnd(12)).join(""));
for (const m of ALL) {
  const cells = services.map((s) => {
    const e = byService.get(s).metrics.get(m);
    return (e ? `yes(${e.n})` : ".").padEnd(12);
  });
  console.log("  " + m.padEnd(w) + cells.join(""));
}

console.log("\n\nTOTALS (count-unit metrics only, whole window)\n");
for (const s of services) {
  const d = byService.get(s);
  console.log(`  ${s}  —  ${d.posts} posts on ${d.dates.size} distinct days`);
  for (const [type, e] of [...d.metrics].sort()) {
    if (e.unit !== "count") { console.log(`      ${type.padEnd(18)} (${e.unit}, not summable)`); continue; }
    console.log(`      ${type.padEnd(18)} ${String(e.total).padStart(9)}`);
  }
  console.log();
}

/* the engagement-rate question, with real numbers */
console.log("\nENGAGEMENT RATE DENOMINATOR CHECK\n");
const sum = (svc, ...types) => {
  const d = byService.get(svc);
  return types.reduce((a, t) => a + (d.metrics.get(t)?.unit === "count" ? d.metrics.get(t).total : 0), 0);
};
let engAll = 0, engWithReach = 0, reachAll = 0;
for (const s of services) {
  const eng = sum(s, "reactions", "comments", "shares", "reposts");
  const reach = sum(s, "reach");
  const hasReach = byService.get(s).metrics.has("reach");
  engAll += eng;
  reachAll += reach;
  if (hasReach) engWithReach += eng;
  console.log(`  ${s.padEnd(11)} engagements ${String(eng).padStart(7)}   reach ${hasReach ? String(reach).padStart(8) : "  ABSENT"}`);
}
console.log();
console.log(`  all engagements / all reach      = ${(engAll / (reachAll || 1) * 100).toFixed(2)}%`);
console.log(`  reach-reporting channels only    = ${(engWithReach / (reachAll || 1) * 100).toFixed(2)}%`);
console.log(`  inflation if we ignore the gap   = ${((engAll / (engWithReach || 1) - 1) * 100).toFixed(1)}%\n`);
