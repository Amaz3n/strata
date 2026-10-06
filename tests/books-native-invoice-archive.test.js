require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  org,
  id,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-native-invoice-posting-database");
const {
  EXPORT_TABLES,
  BOOKS_EXPORT_SCHEMA_VERSION,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const {
  verifyNativeAdjustmentArchive: verify,
} = require("../lib/services/books/native-adjustment-archive");
async function archive(f) {
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []]));
  const actual = (
    await f.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  for (const name of EXPORT_TABLES)
    if (actual.includes(name))
      tables[name] = (
        await f.db.query(
          `select to_jsonb(r) body from ${name} r where org_id=$1 order by to_jsonb(r)::text`,
          [org],
        )
      ).rows.map((r) => r.body);
  return tables;
}
function bundleFor(tables, version = 26) {
  const { booksDigest } = require("../lib/services/books/hash");
  return {
    tables,
    manifest: {
      schemaVersion: version,
      orgId: org,
      legalEntityIds: tables.books_legal_entities.map((r) => r.id).sort(),
      tables: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [
          name,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: tables.files.map((f) => ({
        id: f.id,
        storagePath: f.storage_path,
        sizeBytes: Number(f.size_bytes),
        checksum: f.checksum,
      })),
      supportingHistoricalFiles:
        require("../lib/services/books/tax-attachment-archive").historicalDocumentInventory(
          tables,
          org,
        ),
    },
    supportingObjects: [
      {
        fileId: id(80),
        dataBase64:
          require("./fixtures/books-project-owner-database").supportBytes.toString(
            "base64",
          ),
      },
    ],
    supportingHistoricalObjects: [],
  };
}
test("schema26 closes native operational and manual origins against retained source, policy, owner and exact original money", async (t) => {
  const f = await setup(t),
    r = await f.post();
  await f.prepare({ request: { ...f.request, context: await f.context() } });
  await f.review();
  const tables = await archive(f);
  assert.equal(BOOKS_EXPORT_SCHEMA_VERSION, 32);
  assert.deepEqual(verify(tables, org, 26), []);
  const bundle = bundleFor(tables, 26);
  const report = verifyBooksExportBundle(bundle);
  assert.equal(report.valid, true, JSON.stringify(report));

  assert.ok(verify(tables, org, 25).length);
  const captured = await f.rpc("capture_books_export_snapshot", [org]);
  assert.deepEqual(
    captured.tables.books_native_invoice_postings,
    tables.books_native_invoice_postings,
  );
  for (const corrupt of [
    (b) => delete b.books_native_invoice_postings,
    (b) => b.books_native_invoice_postings.pop(),
    (b) =>
      b.books_native_invoice_postings.push({
        ...b.books_native_invoice_postings[0],
        id: id(999),
      }),
    (b) =>
      (b.books_native_journal_entries.find((e) => e.source_posting_id).fact_id =
        id(200)),
    (b) => b.books_native_journal_lines.pop(),
    (b) => b.invoices.find((i) => i.id === id(100)).total_cents++,
    (b) => b.invoice_lines[0].unit_price_cents++,
    (b) => b.retainage[0].amount_cents++,
    (b) => (b.accounting_policies[0].policy = { changed: true }),
    (b) => (b.books_native_invoice_postings[0].access_event_id = id(999)),
    (b) =>
      b.books_native_journal_entries.push({
        ...r.entry,
        id: id(999),
        source_posting_id: id(999),
      }),
  ]) {
    const b = structuredClone(tables);
    corrupt(b);
    assert.ok(verify(b, org, 26).length);
  }
  await f.db.exec(
    "update invoices set status='paid',metadata=metadata || '{\"label\":\"Reviewed paid source\"}';update accounting_policies set status='superseded'",
  );
  assert.deepEqual(verify(await archive(f), org, 26), []);
  assert.deepEqual(await f.post(), { ...r, created: false });
});
test("populated schema26 restore retains original receipts and period holds, then permits a fresh retainage release after independent reopening", async (t) => {
  const source = await setup(t),
    r = await source.post();
  const h = await source.rpc("set_books_native_period_hold", [
    org,
    entity,
    source.original.native.period.id,
    maker,
    id(730),
    null,
    "hold",
    notes,
  ]);
  const tables = await archive(source),
    target = await setup(t);
  assert.deepEqual(verify(tables, org, 26), []);
  const actual = (
    await target.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  const retained = EXPORT_TABLES.filter((n) => actual.includes(n));
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const name of retained) await target.db.exec(`delete from ${name}`);
  for (const name of retained)
    for (const row of tables[name]) {
      const cols = Object.keys(row);
      await target.db.query(
        `insert into ${name} (${cols.join(",")}) values(${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((c) =>
          row[c] && typeof row[c] === "object"
            ? JSON.stringify(row[c])
            : row[c],
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
  assert.deepEqual(verify(await archive(target), org, 26), []);
  assert.deepEqual(await target.post({ economic: source.original }), {
    ...r,
    created: false,
  });
  await assert.rejects(
    target.db.exec("delete from books_native_invoice_postings"),
    /immutable/,
  );
  await target.db.exec(
    `insert into invoices(id,org_id,project_id,issue_date,total_cents,tax_cents) values('${id(103)}','${org}','${id(70)}','2026-04-16',2000,0);update retainage set release_invoice_id='${id(103)}'`,
  );
  let e = await target.economic({ source: id(103), date: "2026-04-16" });
  await assert.rejects(
    target.post({ id: id(732), entry: id(733), economic: e }),
    /held/,
  );
  await target.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "manage",
    notes,
  ]);
  await target.rpc("set_books_native_period_hold", [
    org,
    entity,
    e.native.period.id,
    reviewer,
    id(731),
    h.id,
    "release",
    notes,
  ]);
  e = await target.economic({ source: id(103), date: "2026-04-16" });
  const release = await target.post({
    id: id(732),
    entry: id(733),
    economic: e,
  });
  assert.equal(release.entry.total_cents, 2000);
  assert.deepEqual(verify(await archive(target), org, 26), []);
});

test("schema25 restore adaptation adds an explicit null operational origin and empty source family without inventing money", async (t) => {
  const f = await setup(t);
  await f.prepare({ request: { ...f.request, context: await f.context() } });
  await f.review();
  const tables = await archive(f);
  delete tables.books_native_invoice_postings;
  for (const row of tables.books_native_journal_entries)
    delete row.source_posting_id;
  const original = bundleFor(tables, 25);
  assert.equal(verifyBooksExportBundle(original).valid, true);
  const actual = (
    await f.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  for (const name of EXPORT_TABLES)
    if (!actual.includes(name))
      await f.db.exec(`create table ${name}(id uuid,org_id uuid)`);
  const columns = (
    await f.db.query(
      `select table_schema as schema,table_name as table,column_name as name,is_nullable='NO' as "notNull",column_default is not null as "hasDefault",is_generated<>'NEVER' as generated from information_schema.columns where table_schema='public'`,
    )
  ).rows;
  const foreignKeys = (
    await f.db.query(
      `select ns.nspname as schema, src.relname as table,tns.nspname as "targetSchema",target.relname as "targetTable",case when c.confmatchtype='f' then 'full' else 'simple' end as match,array(select a.attname from unnest(c.conkey) with ordinality x(n,pos) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=x.n order by x.pos) as columns,array(select a.attname from unnest(c.confkey) with ordinality x(n,pos) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=x.n order by x.pos) as "targetColumns" from pg_constraint c join pg_class src on src.oid=c.conrelid join pg_namespace ns on ns.oid=src.relnamespace join pg_class target on target.oid=c.confrelid join pg_namespace tns on tns.oid=target.relnamespace where c.contype='f' and ns.nspname='public'`,
    )
  ).rows;
  const dependencies = [];
  for (const table of ["orgs", "app_users"])
    dependencies.push({
      schema: "public",
      table,
      rows: (
        await f.db.query(`select to_jsonb(r) body from ${table} r`)
      ).rows.map((r) => r.body),
    });
  dependencies[0].rows = dependencies[0].rows.filter((r) => r.id === org);
  const {
    prepareBooksRestorePlan,
  } = require("../lib/services/books/restore-plan");
  const plan = prepareBooksRestorePlan({
    bundle: original,
    catalog: { columns, foreignKeys },
    dependencies,
    fundingActors: {},
  });
  assert.deepEqual(plan.tables.books_native_invoice_postings, []);
  assert.equal(
    plan.tables.books_native_journal_entries[0].source_posting_id,
    null,
  );
  assert.ok(
    plan.changes.some(
      (c) =>
        c.table === "books_native_journal_entries" &&
        c.fields.includes("source_posting_id"),
    ),
  );
  assert.equal(
    plan.preflight.readyForRestoreAttempt,
    true,
    JSON.stringify(plan.preflight),
  );
  assert.equal(
    "source_posting_id" in original.tables.books_native_journal_entries[0],
    false,
  );
});
