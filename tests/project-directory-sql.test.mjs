import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// npm install --prefix /tmp/arc-projects-test @electric-sql/pglite
// PGLITE_PACKAGE=/tmp/arc-projects-test/node_modules/@electric-sql/pglite/dist/index.js node --test tests/project-directory-sql.test.mjs
const { PGlite } = await import(
  process.env.PGLITE_PACKAGE ?? "@electric-sql/pglite"
);
export const db = new PGlite();
const org = "00000000-0000-0000-0000-000000000001";
const otherOrg = "00000000-0000-0000-0000-000000000002";
const user = "00000000-0000-0000-0000-000000000003";
const division = "00000000-0000-0000-0000-000000000004";
const community = "00000000-0000-0000-0000-000000000005";
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table projects(id uuid primary key, org_id uuid, name text, status text, phase text, location jsonb, client_id uuid, total_value integer, division_id uuid, excluded_from_reporting boolean);
  create table contacts(id uuid primary key, org_id uuid, full_name text);
  create table contracts(id uuid primary key, org_id uuid, project_id uuid, status text, total_cents bigint, created_at timestamptz);
  create table project_members(project_id uuid, org_id uuid, user_id uuid, status text);
  create table lots(org_id uuid, project_id uuid, community_id uuid);
  create table schedule_items(id uuid primary key, org_id uuid, project_id uuid, status text, start_date date, end_date date, progress integer);
`);
await db.exec(
  readFileSync(
    new URL(
      "../supabase/migrations/20260907213516_project_directory_read_model.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
await db.exec(`
  insert into projects select md5(i::text)::uuid, '${org}', 'Project ' || lpad((i/2)::text,5,'0'),
    case when i%3=0 then 'completed' else 'active' end, 'delivery', jsonb_build_object('address','Address '||i), null, i*100, '${division}', false
    from generate_series(1,1205) i;
  insert into projects values (md5('outside')::uuid, '${otherOrg}', 'Outside', 'active', 'delivery', '{}', null, 999, null, false);
  insert into project_members select id, org_id, '${user}', 'active' from projects where name='Project 00001';
  insert into lots select org_id, id, '${community}' from projects where name='Project 00001';
  insert into schedule_items select md5('item'||i)::uuid, '${org}', md5(((i%1205)+1)::text)::uuid,
    case when i%7=0 then 'cancelled' when i%3=0 then 'completed' when i%3=1 then 'blocked' else 'planned' end,
    '2026-01-01'::date, '2026-01-01'::date + (i%10), i%120 from generate_series(1,12050) i;
`);

async function page({
  sort = "name",
  direction = "asc",
  cursor = null,
  all = true,
  divisions = null,
  communityId = null,
  search = "",
  status = "all",
} = {}) {
  return (
    await db.query(
      `select * from get_project_directory_page($1,$2,$3,$4,$5,null,false,$6,$7,$8,$9,$10,51)`,
      [
        org,
        user,
        all,
        divisions,
        communityId,
        search,
        status,
        sort,
        direction,
        cursor,
      ],
    )
  ).rows;
}
test("keyset pagination visits every project beyond 1000 exactly once, including tied names", async () => {
  for (const direction of ["asc", "desc"]) {
    const seen = [];
    let cursor = null;
    do {
      const rows = await page({ direction, cursor });
      seen.push(...rows.slice(0, 50).map((r) => r.id));
      const last = rows[49];
      cursor =
        rows.length > 50
          ? {
              text: last.sort_text,
              number: Number(last.sort_number),
              name: last.name,
              id: last.id,
            }
          : null;
    } while (cursor);
    assert.equal(seen.length, 1205);
    assert.equal(new Set(seen).size, 1205);
  }
});
test("org, membership, division, and community predicates run before pagination", async () => {
  assert.equal((await page({ all: false })).length, 2);
  assert.equal((await page({ divisions: [] })).length, 0);
  assert.equal((await page({ divisions: [otherOrg] })).length, 0);
  assert.equal((await page({ communityId: community })).length, 2);
  assert.equal((await page({ search: "Outside" })).length, 0);
  assert.equal((await page({ search: "Project 00602" })).length, 2);
  assert.equal((await page({ search: "%" })).length, 0);
});
test("every sort and direction yields stable, unique pages with global filtering", async () => {
  for (const sort of ["client", "status", "progress", "value"])
    for (const direction of ["asc", "desc"]) {
      const first = await page({ sort, direction, status: "active" });
      const last = first[49];
      const second = await page({
        sort,
        direction,
        status: "active",
        cursor: {
          text: last.sort_text,
          number: Number(last.sort_number),
          name: last.name,
          id: last.id,
        },
      });
      assert.equal(
        new Set([...first.slice(0, 50), ...second].map((r) => r.id)).size,
        101,
      );
      assert.ok([...first, ...second].every((r) => r.status === "active"));
    }
});
test("database summaries preserve the old duration-weighted calculation", async () => {
  const raw = (await db.query("select * from schedule_items")).rows;
  const expected = new Map();
  for (const row of raw) {
    if (row.status === "cancelled") continue;
    const value =
      row.status === "completed"
        ? 100
        : Math.min(100, Math.max(0, Number(row.progress) || 0));
    const duration = Math.max(
      1,
      (new Date(row.end_date) - new Date(row.start_date)) / 86400000 || 1,
    );
    const acc = expected.get(row.project_id) ?? {
      weighted: 0,
      weight: 0,
      total: 0,
      completed: 0,
      in_progress: 0,
      upcoming: 0,
    };
    acc.weighted += duration * value;
    acc.weight += duration;
    acc.total++;
    if (row.status === "completed") acc.completed++;
    else if (["in_progress", "at_risk", "blocked"].includes(row.status))
      acc.in_progress++;
    else if (row.status === "planned") acc.upcoming++;
    expected.set(row.project_id, acc);
  }
  const result = (
    await db.query(
      "select * from get_project_directory_schedule_summaries($1,null)",
      [org],
    )
  ).rows;
  assert.equal(result.length, expected.size);
  for (const row of result) {
    const e = expected.get(row.project_id);
    assert.equal(row.percent, Math.round(e.weighted / e.weight));
    for (const key of ["total", "completed", "in_progress", "upcoming"])
      assert.equal(Number(row[key]), e[key]);
  }
  assert.equal(
    (
      await db.query(
        "select * from get_project_directory_schedule_summaries($1,$2)",
        [org, []],
      )
    ).rows.length,
    0,
  );
});
test("browser roles cannot forge authorization arguments to call internal read models", async () => {
  const { rows } = await db.query(
    `select r, has_function_privilege(r, 'get_project_directory_page(uuid,uuid,boolean,uuid[],uuid,uuid,boolean,text,text,text,text,jsonb,integer)', 'execute') as allowed from unnest(array['anon','authenticated','service_role']) r`,
  );
  assert.deepEqual(rows, [
    { r: "anon", allowed: false },
    { r: "authenticated", allowed: false },
    { r: "service_role", allowed: true },
  ]);
});
test.after(async () => {
  await db.close();
});
