// Read-only benchmark. Never logs credentials or customer records.
// node scripts/benchmark-project-directory.mjs before|after [output.json]
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const require = createRequire(import.meta.url);
createRequire(require.resolve("next/package.json"))("@next/env").loadEnvConfig(
  process.cwd(),
);
const mode = process.argv[2] ?? "before";
const samples = Number(process.env.BENCHMARK_SAMPLES ?? 7);
let requests = 0,
  bytes = 0;
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (...args) => {
        requests++;
        const response = await fetch(...args);
        bytes += (await response.clone().arrayBuffer()).byteLength;
        return response;
      },
    },
  },
);
const unwrap = ({ data, error }) => {
  if (error) throw new Error(error.message);
  return data ?? [];
};
const projects = unwrap(await db.from("projects").select("org_id").limit(1000));
const counts = new Map();
for (const p of projects) counts.set(p.org_id, (counts.get(p.org_id) ?? 0) + 1);
const orgId =
  process.env.BENCHMARK_ORG_ID ?? [...counts].sort((a, b) => b[1] - a[1])[0][0];
const source = process.env.BENCHMARK_BASELINE_SOURCE
  ? readFileSync(process.env.BENCHMARK_BASELINE_SOURCE, "utf8")
  : execFileSync(
      "git",
      [
        "show",
        "94ec5e86de0faf3e14c924a38961545888ddb84f:lib/services/projects.ts",
      ],
      { encoding: "utf8" },
    );
const select = source.match(/const PROJECT_SELECT = `([\s\S]*?)`/)[1];
async function before() {
  const [rows] = await Promise.all([
    db
      .from("projects")
      .select(select)
      .eq("org_id", orgId)
      .eq("phase", "delivery")
      .order("created_at", { ascending: false })
      .then(unwrap),
    db
      .from("contacts")
      .select(
        "id, org_id, full_name, email, phone, role, contact_type, primary_company_id, created_at, updated_at",
      )
      .eq("org_id", orgId)
      .in("contact_type", ["client", "consultant", "vendor"])
      .order("full_name")
      .then(unwrap),
  ]);
  if (!rows.length) return 0;
  unwrap(
    await db
      .from("accounting_entity_map")
      .select("project_id,dimensions")
      .eq("org_id", orgId)
      .in(
        "project_id",
        rows.map((p) => p.id),
      ),
  );
  for (let from = 0; from < 200000; from += 1000) {
    const batch = unwrap(
      await db
        .from("schedule_items")
        .select("project_id,status,start_date,end_date,progress")
        .eq("org_id", orgId)
        .in(
          "project_id",
          rows.map((p) => p.id),
        )
        .order("id")
        .range(from, from + 999),
    );
    if (batch.length < 1000) break;
  }
  return rows.length;
}
async function after() {
  const rows = unwrap(
    await db.rpc("get_project_directory_page", {
      p_org_id: orgId,
      p_user_id: null,
      p_all_projects: true,
      p_division_ids: null,
      p_community_id: null,
      p_division_id: null,
      p_exclude_reporting: false,
      p_search: "",
      p_status: "all",
      p_sort: "name",
      p_direction: "asc",
      p_cursor: null,
      p_limit: 51,
    }),
  );
  unwrap(
    await db.rpc("get_project_directory_schedule_summaries", {
      p_org_id: orgId,
      p_project_ids: rows.slice(0, 50).map((p) => p.id),
    }),
  );
  return Math.min(rows.length, 50);
}
const run = mode === "before" ? before : after;
await run(); // connection warmup, excluded from samples
const results = [];
for (let i = 0; i < samples; i++) {
  requests = 0;
  bytes = 0;
  const start = performance.now();
  const rows = await run();
  results.push({
    ms: Math.round(performance.now() - start),
    requests,
    responseBytes: bytes,
    rows,
  });
}
const times = results.map((r) => r.ms).sort((a, b) => a - b);
const report = {
  mode,
  measuredAt: new Date().toISOString(),
  scope:
    "Live database read path; excludes authentication, community picker, server rendering and browser hydration. After includes deferred progress request.",
  samples: results,
  medianMs: times[Math.floor(times.length / 2)],
  p95Ms: times[Math.ceil(times.length * 0.95) - 1],
};
if (process.argv[3])
  writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
