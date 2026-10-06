require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { setup } = require("./helpers/books-payroll-payment-fixture");
const { prepare } = require("./helpers/books-payroll-database");
const { id, org } = require("./helpers/books-payroll-register-fixture");
const privacy = fs.readFileSync(
  "supabase/migrations/20261004055553_books_private_payroll_documents.sql",
  "utf8",
);
const payments = fs.readFileSync(
  "supabase/migrations/20261004074806_books_private_payroll_payment_documents.sql",
  "utf8",
);
async function fixture(t) {
  const f = await setup(t);
  await f.db.exec(
    "alter table books_payroll_correction_sources add column if not exists source_proof jsonb;alter table files add metadata jsonb not null default '{}',add visibility text not null default 'private',add share_with_subs boolean not null default false,add share_with_clients boolean not null default false,add uploaded_by uuid default '99400000-0000-4000-8000-000000000050',add project_id uuid,add category text,add source text;alter table doc_versions add version_number integer default 1,add created_by uuid;alter table file_links add file_id uuid;alter table files enable row level security;alter table doc_versions enable row level security;alter table file_links enable row level security;create policy test_file_members on files for all to authenticated using(org_id=current_setting('test.org')::uuid) with check(org_id=current_setting('test.org')::uuid);create policy test_version_members on doc_versions for all to authenticated using(org_id=current_setting('test.org')::uuid) with check(org_id=current_setting('test.org')::uuid);create policy test_link_members on file_links for all to authenticated using(org_id=current_setting('test.org')::uuid) with check(org_id=current_setting('test.org')::uuid);grant select,insert,update,delete on files,doc_versions,file_links to authenticated;grant select,insert,update on files,doc_versions to service_role;grant select on memberships,books_payroll_imports,books_payroll_correction_sources,books_payroll_payment_reviews to service_role;alter role service_role bypassrls",
  );
  await f.db.query("select set_config('test.org',$1,false)", [org]);
  await prepare(f.db, f.evidence);
  await f.db.query(
    "update files set metadata='{" +
      '"source":"original statement"' +
      "}',visibility='public',share_with_subs=true,share_with_clients=true where id=$1",
    [id(70)],
  );
  return f;
}
async function prep(f) {
  return f.db.query(
    "select prepare_books_payroll_payment_review($1,$2,$3,$4,$5,$6,$7)",
    [
      org,
      id(50),
      JSON.stringify(f.payment.request),
      JSON.stringify(f.payment.evidence),
      f.payment.evidenceDigest,
      "Verified original bank and provider settlement statement",
      "private-payment-source-key",
    ],
  );
}
async function assertPrivate(f) {
  const file = (await f.db.query("select * from files where id=$1", [id(70)]))
    .rows[0];
  assert.equal(file.metadata.books_private_kind, "payroll_register");
  assert.equal(file.metadata.source, "original statement");
  assert.equal(file.visibility, "private");
  assert.equal(file.share_with_subs, false);
  assert.equal(file.share_with_clients, false);
  assert.equal(file.storage_path, f.proof.storage_path);
  assert.equal(file.checksum, f.proof.checksum);
  assert.equal(file.current_version_id, id(71));
  await f.db.query(
    "insert into file_links(id,org_id,file_id) values($1,$2,$3)",
    [id(9500), org, id(70)],
  );
  await f.db.exec("set role authenticated");
  assert.equal(
    (await f.db.query("select id from files where id=$1", [id(70)])).rows
      .length,
    0,
  );
  assert.equal(
    (await f.db.query("select id from doc_versions where id=$1", [id(71)])).rows
      .length,
    0,
  );
  assert.equal(
    (await f.db.query("select id from file_links where id=$1", [id(9500)])).rows
      .length,
    0,
  );
  await f.db.exec("reset role");
  assert.equal(
    (
      await f.db.query(
        "select is_books_private_payroll_object($1,$2) private",
        [org, f.proof.storage_path],
      )
    ).rows[0].private,
    true,
  );
  await assert.rejects(
    f.db.query("update files set share_with_clients=true where id=$1", [
      id(70),
    ]),
    /cannot be shared/,
  );
  await assert.rejects(
    f.db.query("update files set metadata='{}' where id=$1", [id(70)]),
    /immutable/,
  );
}
test("retained payment evidence is backfilled private without changing original versions or attribution proof", async (t) => {
  const f = await fixture(t);
  await prep(f);
  const original = (
    await f.db.query("select evidence from books_payroll_payment_reviews")
  ).rows[0].evidence;
  await f.db.exec(privacy);
  await f.db.exec(payments);
  await assertPrivate(f);
  assert.deepEqual(
    (await f.db.query("select evidence from books_payroll_payment_reviews"))
      .rows[0].evidence,
    original,
  );
});
test("new payment attribution atomically restricts every supporting original before ordinary document readers can see the committed review", async (t) => {
  const f = await fixture(t);
  await f.db.exec(privacy);
  await f.db.exec(payments);
  assert.equal(
    (
      await f.db.query(
        "select is_books_private_payroll_object($1,$2) private",
        [org, f.proof.storage_path],
      )
    ).rows[0].private,
    false,
  );
  await prep(f);
  await assertPrivate(f);
  await f.db.exec("set role service_role");
  assert.equal(
    (
      await f.db.query(
        "select is_books_private_payroll_object($1,$2) private",
        [org, f.proof.storage_path],
      )
    ).rows[0].private,
    true,
  );
});
test("recovery makes retained settlement proofs private while preserving archive, source bytes and financial evidence", async (t) => {
  const f = await fixture(t);
  await prep(f);
  const { capture } = require("./helpers/books-payroll-workflow-fixture"),
    { booksDigest } = require("../lib/services/books/hash"),
    {
      verifyBooksExportBundle,
    } = require("../lib/services/books/export-contract"),
    {
      historicalDocumentInventory,
    } = require("../lib/services/books/tax-attachment-archive"),
    { prepareBooksRestorePlan } = require("../lib/services/books/restore-plan");
  const tables = (await capture(f.db)).tables;
  const bundle = {
    tables,
    manifest: {
      schemaVersion: 10,
      orgId: org,
      tables: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [
          name,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: tables.files.map((file) => ({
        id: file.id,
        storagePath: file.storage_path,
        sizeBytes: file.size_bytes,
        checksum: file.checksum,
      })),
      supportingHistoricalFiles: historicalDocumentInventory(tables, org),
    },
    supportingObjects: [
      { fileId: id(8), dataBase64: f.registerBytes.toString("base64") },
      { fileId: id(70), dataBase64: f.paymentBytes.toString("base64") },
    ],
    supportingHistoricalObjects: [],
  };
  assert.equal(
    verifyBooksExportBundle(bundle).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(bundle)),
  );
  const columns = (
    await f.db.query(
      "select table_name as table,column_name as name,is_nullable='NO' as \"notNull\",column_default is not null as \"hasDefault\",is_generated <> 'NEVER' as generated from information_schema.columns where table_schema='public'",
    )
  ).rows;
  const before = structuredClone(bundle),
    plan = prepareBooksRestorePlan({
      bundle,
      catalog: { columns, foreignKeys: [] },
      dependencies: [],
      fundingActors: {},
    }),
    file = plan.tables.files.find((row) => row.id === id(70));
  assert.deepEqual(bundle, before);
  assert.equal(file.metadata.books_private_kind, "payroll_register");
  assert.equal(file.visibility, "private");
  assert.equal(file.share_with_subs, false);
  assert.equal(file.share_with_clients, false);
  assert.equal(file.storage_path, f.proof.storage_path);
  assert.equal(file.checksum, f.proof.checksum);
  assert.deepEqual(
    plan.tables.books_payroll_payment_reviews,
    bundle.tables.books_payroll_payment_reviews,
  );
  assert.deepEqual(plan.tables.journal_entries, bundle.tables.journal_entries);
  assert.deepEqual(plan.tables.journal_lines, bundle.tables.journal_lines);
  assert.ok(
    plan.changes.some(
      (row) =>
        row.table === "files" &&
        row.rowId === id(70) &&
        row.fields.includes("metadata"),
    ),
  );
});
