require("../../scripts/register-ts-node-test");
const fs = require("node:fs"),
  { PGlite } = require("@electric-sql/pglite"),
  { createHash } = require("node:crypto");
const { EXPORT_TABLES } = require("../../lib/services/books/export-contract");
const {
  LEGAL_ENTITY_ARCHIVE_TABLES,
} = require("../../lib/services/books/legal-entity-archive");
const {
  LEGACY_ENTITY_OWNERSHIP_TABLES,
} = require("../../lib/services/books/legacy-entity-ownership");
const id = (n) => "88600000-0000-4000-8000-" + String(n).padStart(12, "0"),
  org = id(1),
  actor = id(2),
  reviewer = id(3),
  reader = id(4),
  entity = id(10),
  profile = id(20),
  notes = "Reviewed entity identity and original legacy ownership evidence";
async function setup(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table memberships(org_id uuid,user_id uuid,status text);insert into orgs values('${org}'),('${id(100)}');insert into app_users values('${actor}'),('${reviewer}'),('${reader}');insert into memberships values('${org}','${actor}','active'),('${org}','${reviewer}','active'),('${org}','${reader}','active');`,
  );
  const migration = (name) =>
    fs.readFileSync("supabase/migrations/" + name, "utf8");
  await db.exec(
    migration("20261004170526_books_native_legal_entity_registry.sql"),
  );
  const foundation = migration(
      "20260801143926_books_accounting_foundation.sql",
    ),
    start = foundation.indexOf("create table public.books_exports (");
  await db.exec(foundation.slice(start, foundation.indexOf("\n);", start) + 4));
  for (const table of EXPORT_TABLES)
    if (
      ![
        ...LEGAL_ENTITY_ARCHIVE_TABLES,
        ...LEGACY_ENTITY_OWNERSHIP_TABLES,
      ].includes(table)
    ) {
      let extra = "";
      if (
        table === "books_project_entity_reviews" ||
        table === "books_project_entity_proposals"
      )
        extra = ",legal_entity_id uuid";
      if (table === "files")
        extra =
          ",storage_path text,checksum text,size_bytes bigint,file_name text,mime_type text,current_version_id uuid";
      if (table === "doc_versions")
        extra =
          ",file_id uuid,storage_path text,checksum text,size_bytes bigint,file_name text,mime_type text";
      if (table === "invoices") extra = ",payload text";
      await db.exec(
        `create table ${table}(id ${table === "audit_log" ? "bigint" : "uuid"} primary key,org_id uuid${extra})`,
      );
    }
  await db.exec(
    migration("20261004172415_books_legal_entity_archive_identity.sql"),
  );
  await db.exec(
    migration("20261004180803_books_export_lossless_row_identity.sql"),
  );
  await db.exec(
    migration("20261004181652_books_legacy_entity_ownership_review.sql"),
  );
  const resolutionCapture = migration(
    "20261004211129_books_journal_request_resolutions.sql",
  );
  await db.exec(
    resolutionCapture.slice(
      resolutionCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      resolutionCapture.lastIndexOf("commit;"),
    ),
  );
  const calendarCapture = migration(
    "20261004215338_books_entity_fiscal_calendars.sql",
  );
  await db.exec(
    calendarCapture.slice(
      calendarCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      calendarCapture.lastIndexOf("commit;"),
    ),
  );
  const chartCapture = migration(
    "20261004222659_books_entity_chart_versions.sql",
  );
  await db.exec(
    chartCapture.slice(
      chartCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      chartCapture.lastIndexOf("commit;"),
    ),
  );
  const projectCapture = migration(
    "20261004233548_books_project_owner_archive.sql",
  );
  await db.exec(
    projectCapture.slice(
      projectCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      projectCapture.lastIndexOf("commit;"),
    ),
  );
  const resolutionMigration = migration(
    "20261005005818_books_project_owner_request_resolutions.sql",
  );
  await db.exec(
    resolutionMigration.slice(
      resolutionMigration.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      resolutionMigration.lastIndexOf("do $$declare t text;r record;begin"),
    ),
  );
  const nativeCapture = migration(
    "20261005013437_books_native_adjustment_ledger.sql",
  );
  await db.exec(
    nativeCapture.slice(
      nativeCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      nativeCapture.lastIndexOf("do $$declare t text;r record;begin"),
    ),
  );
  const invoiceCapture = migration(
    "20261005023412_books_native_invoice_atomic_posting.sql",
  );
  await db.exec(
    invoiceCapture.slice(
      invoiceCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      invoiceCapture.lastIndexOf("do $$declare t text;r record;begin"),
    ),
  );
  const invoiceResolutionCapture = migration(
    "20261005031613_books_native_invoice_request_resolutions.sql",
  );
  await db.exec(
    invoiceResolutionCapture.slice(
      invoiceResolutionCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      invoiceResolutionCapture.lastIndexOf(
        "do $$declare t text;r record;begin",
      ),
    ),
  );
  const incomeCapture = migration(
    "20261005042334_books_native_invoice_income_archive.sql",
  );
  await db.exec(
    incomeCapture.slice(
      incomeCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      incomeCapture.lastIndexOf("commit;"),
    ),
  );
  const incomeResolutionCapture = migration(
    "20261005044458_books_native_invoice_income_resolutions.sql",
  );
  await db.exec(
    incomeResolutionCapture.slice(
      incomeResolutionCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      incomeResolutionCapture.lastIndexOf("commit;"),
    ),
  );
  const correctionCapture = migration(
    "20261005112034_books_native_invoice_correction_proposals.sql",
  );
  await db.exec(
    correctionCapture.slice(
      correctionCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      correctionCapture.lastIndexOf("commit;"),
    ),
  );
  const reviewCapture = migration(
    "20261005123119_books_native_invoice_correction_reviews.sql",
  );
  await db.exec(
    reviewCapture.slice(
      reviewCapture.indexOf(
        "alter function public.capture_books_export_snapshot(uuid) rename",
      ),
      reviewCapture.lastIndexOf("commit;"),
    ),
  );
  const rpc = async (name, args) =>
    (
      await db.query(
        `select ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) value`,
        args,
      )
    ).rows[0].value;
  await rpc("create_books_legal_entity", [
    org,
    entity,
    "BUILDER",
    actor,
    notes,
  ]);
  await rpc("set_books_legal_entity_member", [
    org,
    entity,
    actor,
    reviewer,
    "review",
    notes,
  ]);
  await rpc("set_books_legal_entity_member", [
    org,
    entity,
    actor,
    reader,
    "read",
    notes,
  ]);
  await rpc("prepare_books_legal_entity_profile", [
    org,
    entity,
    profile,
    actor,
    null,
    JSON.stringify({
      legal_name: "Builder LLC",
      legal_form: "llc",
      functional_currency: "USD",
      fiscal_start_month: 7,
      fiscal_start_day: 1,
      effective_on: "2026-07-01",
      identity_evidence: { source: "Original formation paper retained" },
    }),
    notes,
  ]);
  await rpc("review_books_legal_entity_profile", [
    org,
    entity,
    profile,
    reviewer,
    notes,
  ]);
  const bytes = Buffer.from(
      "Original LLC formation and historical bank ownership evidence",
    ),
    checksum = createHash("sha256").update(bytes).digest("hex");
  await db.query("insert into files values($1,$2,$3,$4,$5,$6,$7,$8)", [
    id(90),
    org,
    org + "/books/ownership/original.pdf",
    checksum,
    bytes.length,
    "original.pdf",
    "application/pdf",
    id(91),
  ]);
  await db.query("insert into doc_versions values($1,$2,$3,$4,$5,$6,$7,$8)", [
    id(91),
    org,
    id(90),
    org + "/books/ownership/original.pdf",
    checksum,
    bytes.length,
    "original.pdf",
    "application/pdf",
  ]);
  const evidence = {
    rationale:
      "Original legal identity, chart, banks and every retained source belong to this one entity",
    single_entity_history_confirmed: true,
    document_version_ids: [id(91)],
  };
  const prepare = (
    pid = id(30),
    previous = null,
    decision = evidence,
    by = actor,
  ) =>
    rpc("prepare_books_legacy_entity_proposal", [
      org,
      entity,
      pid,
      by,
      profile,
      previous,
      "2026-09-30",
      JSON.stringify(decision),
      notes,
    ]);
  const review = (pid = id(30), rid = id(40), by = reviewer) =>
    rpc("review_books_legacy_entity_proposal", [
      org,
      entity,
      rid,
      pid,
      by,
      notes,
    ]);
  const read = (pid = id(30), by = actor) =>
    rpc("read_books_legacy_entity_proposal", [org, entity, pid, by]);
  const capture = async () =>
    (await rpc("capture_books_export_snapshot", [org])).tables;
  return { db, rpc, prepare, review, read, capture, bytes, evidence };
}
async function catalog(db) {
  const columns = (
    await db.query(
      "select table_schema schema,table_name as table,column_name name,is_nullable='NO' as \"notNull\",column_default is not null as \"hasDefault\",is_generated<>'NEVER' as generated from information_schema.columns where table_schema='public'",
    )
  ).rows;
  const foreignKeys = (
    await db.query(
      'select n.nspname schema,c.relname as table,array(select a.attname from unnest(k.conkey) with ordinality x(attnum,ord) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.attnum order by x.ord) columns,nt.nspname as "targetSchema",ct.relname as "targetTable",array(select a.attname from unnest(k.confkey) with ordinality x(attnum,ord) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.attnum order by x.ord) as "targetColumns" from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class ct on ct.oid=k.confrelid join pg_namespace nt on nt.oid=ct.relnamespace where k.contype=\'f\' and n.nspname=\'public\'',
    )
  ).rows;
  return { columns, foreignKeys };
}
module.exports = {
  catalog,
  setup,
  id,
  org,
  actor,
  reviewer,
  reader,
  entity,
  profile,
  notes,
};
