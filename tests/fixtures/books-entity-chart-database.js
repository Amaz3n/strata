const fs = require("node:fs"),
  { PGlite } = require("@electric-sql/pglite");
const id = (n) => "88200000-0000-4000-8000-" + String(n).padStart(12, "0"),
  org = id(1),
  entity = id(10),
  maker = id(2),
  reviewer = id(3),
  notes = "Reviewed original entity chart and control accounts";
const read = (name) => fs.readFileSync("supabase/migrations/" + name, "utf8");
async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table memberships(org_id uuid,user_id uuid,status text);insert into orgs values('${org}'),('${id(9)}');insert into app_users values('${maker}'),('${reviewer}'),('${id(4)}');insert into memberships values('${org}','${maker}','active'),('${org}','${reviewer}','active'),('${org}','${id(4)}','active');create table gl_accounts(id uuid primary key,org_id uuid,code text);insert into gl_accounts values('${id(500)}','${org}','1000');`,
  );
  const foundation = read("20260801143926_books_accounting_foundation.sql"),
    start = foundation.indexOf("create table public.books_exports (");
  await db.exec(foundation.slice(start, foundation.indexOf("\n);", start) + 4));
  await db.exec(read("20261004170526_books_native_legal_entity_registry.sql"));
  await db.exec(read("20261004172415_books_legal_entity_archive_identity.sql"));
  await db.exec(
    "create or replace function capture_books_export_snapshot(p_org_id uuid) returns jsonb language sql stable as $$select jsonb_build_object('orgId',p_org_id,'tables','{}'::jsonb)$$",
  );
  await db.exec(read("20261004222659_books_entity_chart_versions.sql"));
  await db.exec(read("20261004230553_books_entity_chart_editor_context.sql"));
  const rpc = async (name, args) =>
    (
      await db.query(
        `select ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) r`,
        args,
      )
    ).rows[0].r;
  const create = async (e = entity, profile = id(20)) => {
    await rpc("create_books_legal_entity", [
      org,
      e,
      "ENTITY_" + e.slice(-3),
      maker,
      notes,
    ]);
    await rpc("set_books_legal_entity_member", [
      org,
      e,
      maker,
      reviewer,
      "review",
      notes,
    ]);
    await rpc("prepare_books_legal_entity_profile", [
      org,
      e,
      profile,
      maker,
      null,
      JSON.stringify({
        legal_name: "Builder LLC",
        legal_form: "llc",
        functional_currency: "USD",
        fiscal_start_month: 1,
        fiscal_start_day: 1,
        effective_on: "2026-01-01",
        identity_evidence: { source: "Original reviewed legal documents" },
      }),
      notes,
    ]);
    await rpc("review_books_legal_entity_profile", [
      org,
      e,
      profile,
      reviewer,
      notes,
    ]);
  };
  await create();
  const {
    constructionEntityChart,
  } = require("../../lib/services/books/entity-chart");
  const prepare = (v = {}) =>
    rpc("prepare_books_entity_chart", [
      v.org ?? org,
      v.entity ?? entity,
      v.id ?? id(30),
      v.profile ?? id(20),
      v.previous ?? null,
      v.actor ?? maker,
      v.effective ?? "2026-01-01",
      JSON.stringify(v.definition ?? constructionEntityChart()),
      v.notes ?? notes,
    ]);
  const review = (v = {}) =>
    rpc("review_books_entity_chart", [
      v.org ?? org,
      v.entity ?? entity,
      v.chart ?? id(30),
      v.id ?? id(40),
      v.actor ?? reviewer,
      v.notes ?? notes,
    ]);
  return { db, rpc, create, prepare, review };
}
module.exports = { setup, id, org, entity, maker, reviewer, notes };
