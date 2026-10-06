require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  org,
  id,
} = require("./fixtures/books-native-invoice-income-database");
const {
  EXPORT_TABLES,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const {
  verifyNativeInvoiceIncomeArchive: verify,
} = require("../lib/services/books/native-invoice-income-archive");
const { booksDigest } = require("../lib/services/books/hash");
async function archive(f) {
  const tables = Object.fromEntries(EXPORT_TABLES.map((n) => [n, []]));
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
function bundle(tables, version = 28) {
  return {
    tables,
    manifest: {
      schemaVersion: version,
      orgId: org,
      legalEntityIds: tables.books_legal_entities.map((r) => r.id).sort(),
      tables: Object.fromEntries(
        Object.entries(tables).map(([n, r]) => [
          n,
          { rows: r.length, checksum: booksDigest(r) },
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
async function choices(f) {
  const account = f.incomeRequest.economic.native.accounts.find(
    (a) => a.definition.account_type === "income",
  );
  const first = {
    ...f.incomeRequest,
    assignments: [{ lineId: id(602), accountId: account.id }],
  };
  const a = await f.selectIncome(first);
  const second = {
    ...f.incomeRequest,
    id: id(901),
    economic: await f.economic(),
  };
  const b = await f.selectIncome(second);
  assert.equal(a.selection.selection_revision, 1);
  assert.equal(b.selection.selection_revision, 2);
  return { first, second, a, b };
}
async function restore(target, tables) {
  const actual = (
    await target.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  const names = EXPORT_TABLES.filter((n) => actual.includes(n));
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const n of names) await target.db.exec(`delete from ${n}`);
  for (const n of names)
    for (const row of tables[n]) {
      const cols = Object.keys(row);
      await target.db.query(
        `insert into ${n} (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((c) =>
          row[c] && typeof row[c] === "object"
            ? JSON.stringify(row[c])
            : row[c],
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
}
test("schema28 retains every income revision and independently closes the journal's exact selection origin", async (t) => {
  const f = await setup(t),
    { b } = await choices(f);
  const money = await f.post({ economic: await f.economic() });
  assert.equal(money.posting.income_selection_id, b.selection.id);
  const tables = await archive(f);
  assert.deepEqual(verify(tables, org, 28), []);
  const report = verifyBooksExportBundle(bundle(tables));
  assert.equal(report.valid, true, JSON.stringify(report));
  const capture = await f.rpc("capture_books_export_snapshot", [org]);
  assert.deepEqual(
    capture.tables.books_native_invoice_income_selections,
    tables.books_native_invoice_income_selections,
  );
  for (const mutate of [
    (b) => delete b.books_native_invoice_income_selections,
    (b) => b.books_native_invoice_income_selections.shift(),
    (b) =>
      b.books_native_invoice_income_selections.push({
        ...b.books_native_invoice_income_selections[0],
      }),
    (b) =>
      (b.books_native_invoice_income_selections[0].access_event_id = id(999)),
    (b) => (b.books_native_invoice_income_selections[0].selection_revision = 3),
    (b) => (b.books_native_invoice_postings[0].income_selection_id = null),
    (b) => (b.books_native_invoice_postings[0].income_selection_id = id(900)),
    (b) => b.books_entity_accounts.pop(),
    (b) => {
      const r = b.books_native_invoice_income_selections[0],
        e = JSON.parse(r.result_text);
      e.lines.find((l) => l.source.id === id(602)).source.unit_price_cents++;
      r.result_text = JSON.stringify(e);
      r.result_sha256 = require("node:crypto")
        .createHash("sha256")
        .update(r.result_text)
        .digest("hex");
    },
  ]) {
    const copy = structuredClone(tables);
    mutate(copy);
    assert.equal(verifyBooksExportBundle(bundle(copy)).valid, false);
  }
  assert.equal(verifyBooksExportBundle(bundle(tables, 27)).valid, false);
});
test("schema27 money without income coding remains verifiable while schema28 recovery refuses a lost selection pointer", async (t) => {
  const f = await setup(t);
  const money = await f.post();
  const tables = await archive(f);
  delete tables.books_native_invoice_postings[0].income_selection_id;
  assert.equal(verifyBooksExportBundle(bundle(tables, 27)).valid, true);
  assert.equal(money.posting.income_selection_id, null);
  const original = bundle(tables, 27);
  delete original.tables.books_native_invoice_income_selections;
  delete original.manifest.tables.books_native_invoice_income_selections;
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
      `select ns.nspname as schema,src.relname as table,tns.nspname as "targetSchema",target.relname as "targetTable",case when c.confmatchtype='f' then 'full' else 'simple' end as match,array(select a.attname from unnest(c.conkey) with ordinality x(n,pos) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=x.n order by x.pos) as columns,array(select a.attname from unnest(c.confkey) with ordinality x(n,pos) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=x.n order by x.pos) as "targetColumns" from pg_constraint c join pg_class src on src.oid=c.conrelid join pg_namespace ns on ns.oid=src.relnamespace join pg_class target on target.oid=c.confrelid join pg_namespace tns on tns.oid=target.relnamespace where c.contype='f' and ns.nspname='public'`,
    )
  ).rows;
  const dependencies = [];
  for (const table of ["orgs", "app_users"])
    dependencies.push({
      schema: "public",
      table,
      rows: (await f.db.query(`select to_jsonb(r) body from ${table} r`)).rows
        .map((r) => r.body)
        .filter((r) => table !== "orgs" || r.id === org),
    });
  const plan =
    require("../lib/services/books/restore-plan").prepareBooksRestorePlan({
      bundle: original,
      catalog: { columns, foreignKeys },
      dependencies,
      fundingActors: {},
    });
  assert.deepEqual(plan.tables.books_native_invoice_income_selections, []);
  assert.equal(
    plan.tables.books_native_invoice_postings[0].income_selection_id,
    null,
  );
  assert.equal(
    plan.preflight.readyForRestoreAttempt,
    true,
    JSON.stringify(plan.preflight),
  );
  assert.equal(
    "income_selection_id" in original.tables.books_native_invoice_postings[0],
    false,
  );
  const coded = await setup(t);
  await choices(coded);
  const economic = await coded.economic();
  const api = require("../lib/services/books/native-invoice-recovery");
  const scope = {
    orgId: org,
    actorId: coded.incomeRequest.expectedActorId,
    entityId: economic.native.owner.legal_entity_id,
    projectId: id(70),
    invoiceId: id(100),
  };
  const record = {
      version: 1,
      request: { ...coded.resolutionRequest, economic },
    },
    data = new Map();
  const storage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const locks = { request: (_, fn) => fn() };
  const transport = async (r) => {
    const result = await coded.post({
      id: r.request.id,
      entry: r.request.entryId,
      economic: r.request.economic,
      notes: r.request.notes,
    });
    result.posting.income_selection_id = null;
    return { success: true, data: result };
  };
  await assert.rejects(
    api.submitNativeInvoiceRecovery({
      scope,
      record,
      storage,
      locks,
      transport,
    }),
    /selection origin/,
  );
  assert.deepEqual(api.readNativeInvoiceRecovery(storage, scope), record);
});
test("populated unposted coding restore preserves exact old retries and continues ordinal history before posting", async (t) => {
  const source = await setup(t),
    { first, a } = await choices(source),
    tables = await archive(source),
    target = await setup(t);
  assert.equal(verifyBooksExportBundle(bundle(tables)).valid, true);
  await restore(target, tables);
  assert.deepEqual((await target.selectIncome(first)).selection, a.selection);
  const fresh = {
    ...target.incomeRequest,
    id: id(902),
    economic: await target.economic(),
  };
  const third = await target.selectIncome(fresh);
  assert.equal(third.selection.selection_revision, 3);
  const money = await target.post({ economic: await target.economic() });
  assert.equal(money.posting.income_selection_id, id(902));
  const report = verifyBooksExportBundle(bundle(await archive(target)));
  assert.equal(report.valid, true, JSON.stringify(report));
});
test("posted coding restore recovers original money and coding without permitting a new recoding", async (t) => {
  const source = await setup(t),
    { first, a } = await choices(source),
    economic = await source.economic();
  const money = await source.post({ economic }),
    tables = await archive(source),
    target = await setup(t);
  await restore(target, tables);
  assert.deepEqual((await target.selectIncome(first)).selection, a.selection);
  assert.deepEqual(await target.post({ economic }), {
    ...money,
    created: false,
  });
  await assert.rejects(
    target.selectIncome({
      ...target.incomeRequest,
      id: id(902),
      economic: await target.economic(),
    }),
    /governed reversal/,
  );
  assert.deepEqual(verify(await archive(target), org, 28), []);
});
test("schema29 restores a permanent cancelled coding nonce and permits fresh coding and original journal recovery", async (t) => {
  const source = await setup(t);
  await source.db.query(
    "update invoice_lines set unit_price_cents=12000 where id=$1",
    [id(602)],
  );
  await source.db.query(
    "update invoices set total_cents=total_cents+1000 where id=$1",
    [id(100)],
  );
  const cancelled = await source.resolveIncome();
  const originalTables = await archive(source),
    original = bundle(originalTables, 29);
  const {
    verifyNativeIncomeResolutionArchive: verifyResolution,
  } = require("../lib/services/books/native-invoice-income-resolution");
  assert.equal(
    verifyBooksExportBundle(original).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(original)),
  );
  assert.equal(
    verifyBooksExportBundle(bundle(originalTables, 28)).valid,
    false,
  );
  const capture = await source.rpc("capture_books_export_snapshot", [org]);
  assert.deepEqual(
    capture.tables.books_native_invoice_income_resolutions,
    originalTables.books_native_invoice_income_resolutions,
  );
  for (const mutate of [
    (b) => delete b.books_native_invoice_income_resolutions,
    (b) =>
      b.books_native_invoice_income_resolutions.push({
        ...b.books_native_invoice_income_resolutions[0],
      }),
    (b) =>
      (b.books_native_invoice_income_resolutions[0].resolved_access_event_id =
        id(999)),
    (b) => (b.books_native_invoice_income_resolutions[0].request_id = id(999)),
    (b) => (b.books_native_invoice_income_resolutions[0].org_id = id(9)),
    (b) => b.books_entity_chart_versions.pop(),
    (b) => b.books_native_invoice_income_selections.push({ id: id(900) }),
  ]) {
    const changed = structuredClone(originalTables);
    mutate(changed);
    assert.equal(verifyBooksExportBundle(bundle(changed, 29)).valid, false);
  }
  const target = await setup(t);
  await restore(target, originalTables);
  assert.deepEqual(await target.resolveIncome(source.incomeRequest), cancelled);
  await assert.rejects(target.selectIncome(), /cancelled/);
  const fresh = {
    ...target.incomeRequest,
    id: id(901),
    economic: await target.economic(),
  };
  await target.selectIncome(fresh);
  const economic = await target.economic(),
    money = await target.post({ economic });
  assert.equal(money.posting.income_selection_id, id(901));
  const retained = await archive(target),
    report = verifyBooksExportBundle(bundle(retained, 29));
  assert.equal(report.valid, true, JSON.stringify(report));
  assert.deepEqual(verifyResolution(retained, org, 29), []);
  const again = await setup(t);
  await restore(again, retained);
  assert.deepEqual(await again.resolveIncome(source.incomeRequest), cancelled);
  assert.deepEqual(await again.post({ economic }), {
    ...money,
    created: false,
  });
  await assert.rejects(again.selectIncome(), /cancelled/);
});
