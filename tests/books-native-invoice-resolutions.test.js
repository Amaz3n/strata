require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-native-invoice-resolution-database");
test("atomic absent native invoice resolution retains immutable exact cancellation and permanently prevents its nonce posting", async (t) => {
  const f = await setup(t),
    r = await f.resolve();
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.posted, false);
  assert.equal(r.ledgerActivated, false);
  assert.equal(r.entry, null);
  assert.deepEqual(r.lines, []);
  assert.deepEqual(await f.resolve(), r);
  for (const v of [
    { id: id(741) },
    { reason: notes + " changed" },
    { request: { ...f.resolutionRequest, entryId: id(799) } },
  ])
    await assert.rejects(f.resolve(v), /retry differs/);
  await assert.rejects(f.post(), /cancelled/);
  await assert.rejects(
    f.post({
      economic: {
        ...f.original,
        project: { ...f.original.project, name: "later note" },
      },
    }),
    /cancelled/,
  );
  await assert.rejects(
    f.db.exec("delete from books_native_invoice_request_resolutions"),
    /immutable/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_postings",
      )
    ).rows[0].n,
    0,
  );
  assert.equal((await f.post({ id: id(702), entry: id(703) })).created, true);
  await assert.rejects(
    f.db.query(
      `insert into books_native_invoice_postings select (jsonb_populate_record(null::books_native_invoice_postings,to_jsonb(p)||jsonb_build_object('id',$1::uuid,'entry_id',$2::uuid))).* from books_native_invoice_postings p`,
      [id(700), id(799)],
    ),
    /cancelled/,
  );
});
test("resolution after native invoice commit returns only its original complete journal even when current economics changed", async (t) => {
  const f = await setup(t),
    p = await f.post();
  await f.db.exec(
    "update invoices set status='paid';update accounting_policies set status='superseded'",
  );
  const r = await f.resolve();
  assert.equal(r.outcome, "committed_original");
  assert.equal(r.resolution, null);
  assert.deepEqual(r.posting, p.posting);
  assert.deepEqual(r.entry, p.entry);
  assert.deepEqual(r.lines, p.lines);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_invoice_request_resolutions",
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(
    f.resolve({
      request: { ...f.resolutionRequest, notes: notes + " changed" },
    }),
    /differs/,
  );
});
test("resolution scopes original actor/source/entity and requires current authority without approving stale source economics", async (t) => {
  const f = await setup(t);
  for (const v of [
    { actor: reviewer },
    { org: id(9) },
    { entity: id(999) },
    { project: id(71) },
    { request: { ...f.resolutionRequest, unexpected: true } },
  ])
    await assert.rejects(f.resolve(v));
  await f.db.exec(
    "update invoice_lines set unit_price_cents=11001 where unit_price_cents=11000",
  );
  await assert.rejects(f.post(), /snapshot changed/);
  assert.equal((await f.resolve()).outcome, "cancelled");
  await assert.rejects(f.post(), /cancelled/);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "manage",
    notes,
  ]);
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    reviewer,
    maker,
    "revoked",
    notes,
  ]);
  await assert.rejects(f.resolve(), /access/);
});

async function archive(f) {
  const { EXPORT_TABLES } = require("../lib/services/books/export-contract");
  const tables = Object.fromEntries(EXPORT_TABLES.map((n) => [n, []])),
    actual = (
      await f.db.query(
        "select tablename from pg_tables where schemaname='public'",
      )
    ).rows.map((r) => r.tablename);
  for (const n of EXPORT_TABLES)
    if (actual.includes(n))
      tables[n] = (
        await f.db.query(
          `select to_jsonb(r) body from ${n} r where org_id=$1 order by to_jsonb(r)::text`,
          [org],
        )
      ).rows.map((r) => r.body);
  return tables;
}
test("schema27 retains cancellation authority/exclusivity and restores a permanently fenced nonce with ordinary fresh money afterwards", async (t) => {
  const source = await setup(t),
    r = await source.resolve(),
    tables = await archive(source);
  const {
    verifyNativeInvoiceResolutionArchive: verify,
  } = require("../lib/services/books/native-invoice-resolution");
  assert.deepEqual(verify(tables, org, 27), []);
  const { booksDigest } = require("../lib/services/books/hash");
  const {
    verifyBooksExportBundle,
  } = require("../lib/services/books/export-contract");
  const bundle = {
    tables,
    manifest: {
      schemaVersion: 27,
      orgId: org,
      legalEntityIds: tables.books_legal_entities.map((r) => r.id).sort(),
      tables: Object.fromEntries(
        Object.entries(tables).map(([n, rows]) => [
          n,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: tables.files.map((f) => ({
        id: f.id,
        storagePath: f.storage_path,
        checksum: f.checksum,
        sizeBytes: Number(f.size_bytes),
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
  const report = verifyBooksExportBundle(bundle);
  assert.equal(report.valid, true, JSON.stringify(report));

  assert.ok(verify(tables, org, 26).length);
  const snapshot = await source.rpc("capture_books_export_snapshot", [org]);
  assert.deepEqual(
    snapshot.tables.books_native_invoice_request_resolutions,
    tables.books_native_invoice_request_resolutions,
  );
  for (const change of [
    (b) => delete b.books_native_invoice_request_resolutions,
    (b) =>
      b.books_native_invoice_request_resolutions.push({
        ...b.books_native_invoice_request_resolutions[0],
      }),
    (b) =>
      (b.books_native_invoice_request_resolutions[0].resolved_access_event_id =
        id(999)),
    (b) =>
      (b.books_native_invoice_request_resolutions[0].request_sha256 =
        "a".repeat(64)),
    (b) => b.books_native_invoice_postings.push({ id: id(700) }),
    (b) => {
      const row = b.books_native_invoice_request_resolutions[0],
        q = JSON.parse(row.request_text);
      q.id = id(799);
      row.request_text = JSON.stringify(q);
      row.request_sha256 = require("node:crypto")
        .createHash("sha256")
        .update(row.request_text)
        .digest("hex");
    },
  ]) {
    const b = structuredClone(tables);
    change(b);
    assert.ok(verify(b, org, 27).length);
  }
  const target = await setup(t),
    actual = (
      await target.db.query(
        "select tablename from pg_tables where schemaname='public'",
      )
    ).rows.map((r) => r.tablename),
    names = Object.keys(tables).filter((n) => actual.includes(n));
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const n of names) await target.db.exec(`delete from ${n}`);
  for (const n of names)
    for (const row of tables[n]) {
      const cols = Object.keys(row);
      await target.db.query(
        `insert into ${n} (${cols.join(",")}) values(${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((k) =>
          row[k] && typeof row[k] === "object"
            ? JSON.stringify(row[k])
            : row[k],
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
  assert.deepEqual(
    await target.resolve({ request: source.resolutionRequest }),
    r,
  );
  await assert.rejects(target.post({ economic: source.original }), /cancelled/);
  await assert.rejects(
    target.db.exec("delete from books_native_invoice_request_resolutions"),
    /immutable/,
  );
  const fresh = await target.economic();
  assert.equal(
    (await target.post({ id: id(702), entry: id(703), economic: fresh }))
      .posted,
    true,
  );
  assert.deepEqual(verify(await archive(target), org, 27), []);
});
