#!/usr/bin/env node
/**
 * discover-buffer.mjs — step 1: Buffer org + channel discovery.
 *
 * Run: node --env-file=.env scripts/discover-buffer.mjs
 *
 * Read-only. Prints the org ID and channel IDs needed for config, and probes
 * whether this key can actually read insights (metrics), which is the thing
 * that quietly fails if the key is an OAuth App Client rather than a personal
 * key. Re-run this later whenever you connect a new channel.
 *
 * Nothing here is guessed: field names come from schema introspection, so a
 * rename upstream shows up as a missing field in the output rather than as a
 * confidently wrong query.
 */

import { bufferQuery } from "./fetch.mjs";

const line = (s = "") => console.log(s);
const rule = () => line("-".repeat(72));

/* ------------------------------------------------------------------ *
 * introspection — ask the schema what exists before selecting fields
 * ------------------------------------------------------------------ */

/** Field names on an object type, or null if introspection is disabled. */
async function objectFields(typeName) {
  try {
    const data = await bufferQuery(
      `query($name: String!) {
         __type(name: $name) { fields { name type { kind name ofType { kind name } } } }
       }`,
      { name: typeName }
    );
    return data.__type?.fields ?? null;
  } catch {
    return null;
  }
}

/** Input-object field names + their type, for printing an input's real shape. */
async function inputFields(typeName) {
  try {
    const data = await bufferQuery(
      `query($name: String!) {
         __type(name: $name) {
           inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
         }
       }`,
      { name: typeName }
    );
    return data.__type?.inputFields ?? null;
  } catch {
    return null;
  }
}

/** Flatten NON_NULL/LIST wrappers down to a readable type name. */
function typeName(t) {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return typeName(t.ofType) + "!";
  if (t.kind === "LIST") return "[" + typeName(t.ofType) + "]";
  return t.name ?? "?";
}

/** Leaf fields only — selecting an object field without a subselection errors. */
function leafNames(fields) {
  if (!fields) return null;
  return fields
    .filter((f) => {
      let t = f.type;
      while (t && (t.kind === "NON_NULL" || t.kind === "LIST")) t = t.ofType;
      return t && (t.kind === "SCALAR" || t.kind === "ENUM");
    })
    .map((f) => f.name);
}

/* ------------------------------------------------------------------ *
 * 1. organizations
 * ------------------------------------------------------------------ */
async function organizations() {
  const data = await bufferQuery(`query { account { organizations { id name } } }`);
  return data.account?.organizations ?? [];
}

/* ------------------------------------------------------------------ *
 * 2. channels — select only fields the schema confirms exist
 * ------------------------------------------------------------------ */
const WANTED_CHANNEL_FIELDS = [
  "id", "name", "displayName", "service", "serviceId",
  "type", "isDisconnected", "isLocked", "timezone",
];

async function channels(organizationId, available) {
  const selected = available
    ? WANTED_CHANNEL_FIELDS.filter((f) => available.includes(f))
    : ["id", "name", "service"]; // introspection off: conservative fallback

  const data = await bufferQuery(
    `query($input: ChannelsInput!) { channels(input: $input) { ${selected.join(" ")} } }`,
    { input: { organizationId } }
  );
  return { rows: data.channels ?? [], selected };
}

/* ------------------------------------------------------------------ *
 * 3. insights probe — does this key return metrics at all?
 *
 * The failure we're hunting: a key WITHOUT insights access still returns posts
 * happily, just with empty/absent `metrics`. That reads as "no engagement this
 * week" rather than as an auth problem, so check it explicitly and loudly.
 * ------------------------------------------------------------------ */
async function insightsProbe(organizationId) {
  const end = new Date();
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 30);
  const isoT = (d) => d.toISOString().slice(0, 10);

  const query = `
    query($input: PostsInput!, $first: Int) {
      posts(input: $input, first: $first) {
        edges { node { id sentAt channelService metrics { type name value unit } } }
        pageInfo { hasNextPage endCursor }
      }
    }`;

  // fetch.mjs assumes this input shape; if it's wrong we want the schema's
  // actual shape printed rather than a vague error.
  const input = {
    organizationId,
    filter: {
      status: ["sent"],
      dueAt: { start: `${isoT(start)}T00:00:00Z`, end: `${isoT(end)}T23:59:59Z` },
    },
  };

  try {
    const data = await bufferQuery(query, { input, first: 10 });
    return { ok: true, edges: data.posts?.edges ?? [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * main
 * ------------------------------------------------------------------ */
async function main() {
  line();
  line("Buffer discovery — endpoint https://api.buffer.com");
  rule();

  const orgs = await organizations();
  if (orgs.length === 0) {
    line("No organizations returned. The key authenticated but sees no org.");
    process.exitCode = 1;
    return;
  }

  line(`Organizations (${orgs.length}):`);
  for (const o of orgs) line(`  ${o.id}   ${o.name ?? "(unnamed)"}`);
  line();
  line(`  -> put this in .env:  BUFFER_ORG_ID=${orgs[0].id}`);
  if (orgs.length > 1) line("     (more than one org — confirm which is the right one)");
  line();

  const channelFieldDefs = await objectFields("Channel");
  const available = leafNames(channelFieldDefs);
  if (!available) line("Note: schema introspection unavailable; using fallback field set.");

  for (const org of orgs) {
    rule();
    line(`Channels in ${org.name ?? org.id}:`);
    let rows, selected;
    try {
      ({ rows, selected } = await channels(org.id, available));
    } catch (err) {
      line(`  channels query failed: ${err.message}`);
      continue;
    }
    line(`  (fields selected: ${selected.join(", ")})`);
    line();
    if (rows.length === 0) line("  none connected.");
    for (const c of rows) {
      const label = c.displayName ?? c.name ?? "(unnamed)";
      const flags = [
        c.isDisconnected ? "DISCONNECTED" : null,
        c.isLocked ? "locked" : null,
      ].filter(Boolean).join(" ");
      line(`  ${c.id}  ${(c.service ?? "?").padEnd(12)} ${label}${flags ? "  [" + flags + "]" : ""}`);
    }
    line();
  }

  /* --- insights probe on the first org --- */
  rule();
  line("Insights probe (last 30 days, first 10 posts):");
  line();
  const probe = await insightsProbe(orgs[0].id);

  if (!probe.ok) {
    line(`  posts query FAILED: ${probe.error}`);
    line();
    line("  Schema shape for the inputs we guessed at (use this to correct it):");
    for (const t of ["PostsInput", "PostsFilterInput", "PostsFiltersInput"]) {
      const f = await inputFields(t);
      if (!f) continue;
      line(`    ${t}:`);
      for (const x of f) line(`      ${x.name}: ${typeName(x.type)}`);
    }
    process.exitCode = 1;
    return;
  }

  const edges = probe.edges;
  line(`  posts returned: ${edges.length}`);
  const withMetrics = edges.filter((e) => (e.node.metrics ?? []).length > 0);
  line(`  posts carrying metrics: ${withMetrics.length}`);
  line();

  if (edges.length === 0) {
    line("  No posts in the last 30 days — can't confirm insights access from this.");
    line("  Widen the window or post something, then re-run.");
  } else if (withMetrics.length === 0) {
    line("  *** posts came back but NO metrics on any of them. ***");
    line("  That is the signature of a key without insights access (OAuth App");
    line("  Client rather than a personal key). Metrics would read as zero");
    line("  engagement forever. Fix the key before going further.");
    process.exitCode = 1;
  } else {
    line("  Insights access CONFIRMED.");
    line();
    const types = new Map();
    for (const e of withMetrics) {
      for (const m of e.node.metrics) {
        const k = `${e.node.channelService}|${m.type}`;
        if (!types.has(k)) types.set(k, { unit: m.unit, sample: m.value });
      }
    }
    line("  Metric types seen (service | type -> unit, sample value):");
    for (const [k, v] of [...types].sort()) {
      line(`    ${k.padEnd(34)} ${String(v.unit ?? "?").padEnd(12)} ${v.sample}`);
    }
    line();
    line("  (Step 2 confirms this per-channel across a longer window.)");
  }
  line();
}

main().catch((err) => {
  console.error("\nDiscovery failed:", err.message);
  process.exitCode = 1;
});
