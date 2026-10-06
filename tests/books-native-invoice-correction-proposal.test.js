require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const {
  setup,
  id,
  org,
} = require("./fixtures/books-native-invoice-correction-database");
const {
  verifyNativeInvoiceCorrectionProposal: verify,
  verifyNativeInvoiceCorrectionProposalArchive: verifyArchive,
  NATIVE_INVOICE_CORRECTION_PROPOSAL_TABLE: TABLE,
} = require("../lib/services/books/native-invoice-correction-proposal");
const {
  EXPORT_TABLES,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const { booksDigest } = require("../lib/services/books/hash");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const {
  archive,
  bundle,
  restore,
} = require("./fixtures/books-native-invoice-correction-archive");
test("actual immutable proposal persists complete original intent and independently verified reversal with exact retries", async (t) => {
  const f = await setup(t),
    r = await f.prepare(),
    v = verify(r.proposal);
  assert.deepEqual(v.request, f.request);
  assert.equal(r.created, true);
  for (const field of [
    "posted",
    "reviewed",
    "sourceChanged",
    "ledgerActivated",
  ])
    assert.equal(r[field], false);
  assert.equal(v.derivation.plan.totalCents, f.money.entry.total_cents);
  await f.db.exec(
    'update invoices set metadata=metadata||\'{"label":"Later label"}\'::jsonb',
  );
  assert.deepEqual(await f.prepare(), { ...r, created: false });
  await assert.rejects(
    f.prepare({ ...f.request, notes: f.request.notes + " changed" }),
    /retry differs/,
  );
  for (const sql of [
    `delete from ${TABLE}`,
    `update ${TABLE} set request_sha256=repeat('0',64)`,
  ])
    await assert.rejects(f.db.exec(sql), /immutable/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
});
test("private proposal direct inserts derive server evidence and enforce actual original scope", async (t) => {
  const f = await setup(t),
    bad = { ...f.request, originalPostingId: id(999) };
  const sql = require("node:fs").readFileSync(
    "supabase/tests/books_native_invoice_correction_proposals.test.sql",
    "utf8",
  );
  const catalog = [
    ...sql.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
  ];
  assert.equal(catalog.length, 8);
  for (const [, expression, label] of catalog)
    assert.equal(
      (await f.db.query(`select (${expression}) as ok`)).rows[0].ok,
      true,
      label,
    );
  await assert.rejects(f.prepare(bad), /missing|foreign/);
  assert.equal(
    (await f.db.query(`select count(*)::int n from ${TABLE}`)).rows[0].n,
    0,
  );
  await f.db.query(
    `insert into ${TABLE}(id,org_id,legal_entity_id,project_id,prepared_by,request_text,request_sha256,derivation_text,derivation_sha256) values($1,$2,$3,$4,$5,$6,repeat('0',64),'{}',repeat('0',64))`,
    [
      f.request.id,
      org,
      f.request.context.owner.legal_entity_id,
      id(70),
      f.request.expectedActorId,
      JSON.stringify(f.request),
    ],
  );
  const r = (await f.db.query(`select to_jsonb(r) body from ${TABLE} r`))
    .rows[0].body;
  assert.notEqual(r.derivation_text, "{}");
  verify(r);
  const privileges = (
    await f.db.query(
      `select relrowsecurity,has_table_privilege('anon',oid,'select') a,has_table_privilege('authenticated',oid,'insert') u,has_table_privilege('service_role',oid,'update,delete') w from pg_class where oid='${TABLE}'::regclass`,
    )
  ).rows[0];
  assert.deepEqual(privileges, {
    relrowsecurity: true,
    a: false,
    u: false,
    w: false,
  });
});
test("schema30 proposal archive closes original journal, frozen definitions and historical authority", async (t) => {
  const f = await setup(t);
  await f.prepare();
  const tables = await archive(f);
  assert.deepEqual(verifyArchive(tables, org, 30), []);
  const report = verifyBooksExportBundle(bundle(tables));
  assert.equal(report.valid, true, JSON.stringify(report));
  assert.equal(verifyBooksExportBundle(bundle(tables, 29)).valid, false);
  const captured = await f.rpc("capture_books_export_snapshot", [org]);
  assert.equal(captured.tables[TABLE].length, 1);
  const legacy = await f.rpc("capture_books_legacy_ownership_evidence", [
    org,
    f.request.expectedActorId,
  ]);
  assert.equal(typeof legacy.populationText, "string");
  assert.equal(JSON.parse(legacy.populationText)[TABLE], undefined);
  for (const edit of [
    (t) => {
      delete t[TABLE];
    },
    (t) => {
      t[TABLE].push(t[TABLE][0]);
    },
    (t) => {
      t[TABLE][0].prepared_access_event_id = id(999);
    },
    (t) => {
      t.books_native_journal_lines[0].dimensions.forged = true;
    },
    (t) => {
      const r = t[TABLE][0],
        d = JSON.parse(r.derivation_text),
        j = JSON.parse(d.originalJournalText);
      j.lines[0].dimensions.forged = true;
      d.originalJournalText = JSON.stringify(j);
      d.originalJournalSha256 = sha(d.originalJournalText);
      r.derivation_text = JSON.stringify(d);
      r.derivation_sha256 = sha(r.derivation_text);
    },
  ]) {
    const copy = structuredClone(tables);
    edit(copy);
    assert.equal(verifyBooksExportBundle(bundle(copy)).valid, false);
  }
});
test("populated scoped restore preserves original proposal and journal retries and permits fresh correction preparation", async (t) => {
  const source = await setup(t),
    target = await setup(t),
    r = await source.prepare(),
    tables = await archive(source);
  assert.equal(verifyBooksExportBundle(bundle(tables)).valid, true);
  await restore(target, tables);
  assert.deepEqual(await target.prepare(source.request), {
    ...r,
    created: false,
  });
  assert.equal(
    (await target.post({ economic: source.original })).created,
    false,
  );
  const q = {
    ...source.request,
    id: id(981),
    context: (await target.economic({ date: "2026-04-16" })).native,
  };
  assert.equal((await target.prepare(q)).created, true);
  assert.equal(
    (await target.db.query(`select count(*)::int n from ${TABLE}`)).rows[0].n,
    2,
  );
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    1,
  );
  const report = verifyBooksExportBundle(bundle(await archive(target)));
  assert.equal(report.valid, true, JSON.stringify(report));
});

test("schema29 restores an empty correction family into schema30 without inventing proposals", async (t) => {
  const f = await setup(t),
    tables = await archive(f),
    old = bundle(tables, 29);
  delete old.tables[TABLE];
  delete old.manifest.tables[TABLE];
  assert.equal(verifyBooksExportBundle(old).valid, true);
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
      bundle: old,
      catalog: { columns, foreignKeys },
      dependencies,
      fundingActors: {},
    });
  assert.deepEqual(plan.tables[TABLE], []);
  assert.equal(
    plan.preflight.readyForRestoreAttempt,
    true,
    JSON.stringify(plan.preflight),
  );
  assert.equal(TABLE in old.tables, false);
});
