require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const {
  setup,
  org,
  id,
} = require("./fixtures/books-native-adjustment-database");
const {
  NATIVE_ADJUSTMENT_TABLES,
  verifyNativeAdjustmentArchive,
} = require("../lib/services/books/native-adjustment-archive");
const { EXPORT_TABLES } = require("../lib/services/books/export-contract");
async function archive(f) {
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []]));
  const actual = (
    await f.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  for (const t of EXPORT_TABLES)
    if (actual.includes(t))
      tables[t] = (
        await f.db.query(
          `select to_jsonb(r) row from ${t} r where org_id=$1 order by id`,
          [org],
        )
      ).rows.map((r) => r.row);
  return tables;
}
test("native schema25 retains complete original monetary history and rejects rehashed business corruption", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.review();
  const tables = await archive(f);
  assert.deepEqual(verifyNativeAdjustmentArchive(tables, org, 25), []);
  assert.ok(verifyNativeAdjustmentArchive(tables, org, 24).length);
  const captured = await f.rpc("capture_books_export_snapshot", [org]);
  for (const table of NATIVE_ADJUSTMENT_TABLES)
    assert.deepEqual(captured.tables[table], tables[table]);
  for (const corrupt of [
    (b) => b.books_native_journal_lines.pop(),
    (b) => b.books_native_journal_lines[0].debit_cents++,
    (b) =>
      (b.books_native_adjustment_reviews[0].reviewed_by =
        b.books_native_adjustment_facts[0].prepared_by),
    (b) =>
      (b.books_native_adjustment_reviews[0].request_sha256 = "b".repeat(64)),
    (b) => (b.books_entity_accounts[0].code = "FORGED"),
    (b) =>
      b.books_native_journal_entries.push({
        ...b.books_native_journal_entries[0],
        id: id(999),
      }),
    (b) =>
      (b.books_native_adjustment_facts[0].prepared_access_event_id = id(999)),
    (b) => {
      let row = b.books_native_adjustment_facts[0],
        r = JSON.parse(row.request_text);
      r.draft.memo = "Rehashed silently rewritten accounting purpose";
      row.request_text = JSON.stringify(r);
      row.request_sha256 = createHash("sha256")
        .update(row.request_text)
        .digest("hex");
    },
  ]) {
    const b = structuredClone(tables);
    corrupt(b);
    assert.ok(verifyNativeAdjustmentArchive(b, org, 25).length);
  }
  await f.db.exec(
    "alter table invoices add column later_amount integer;update invoices set later_amount=999",
  );
  assert.deepEqual(
    verifyNativeAdjustmentArchive(await archive(f), org, 25),
    [],
  );
});
test("native archive requires explicit empty families for schema25 and prevents orphan legs on pending or rejected requests", async (t) => {
  const f = await setup(t);
  await f.prepare();
  const tables = await archive(f);
  assert.deepEqual(verifyNativeAdjustmentArchive(tables, org, 25), []);
  delete tables.books_native_period_holds;
  assert.ok(verifyNativeAdjustmentArchive(tables, org, 25).length);
});
test("populated native restore retains exact receipts, reactivates immutability and period holds, then permits fresh reviewed money after independent release", async (t) => {
  const source = await setup(t),
    p = await source.prepare(),
    r = await source.review();
  const held = await source.rpc("set_books_native_period_hold", [
    org,
    require("./fixtures/books-native-adjustment-database").entity,
    source.request.context.period.id,
    require("./fixtures/books-native-adjustment-database").maker,
    id(220),
    null,
    "hold",
    "Freeze restored native fiscal period",
  ]);
  const tables = await archive(source),
    target = await setup(t);
  assert.deepEqual(verifyNativeAdjustmentArchive(tables, org, 25), []);
  const actual = (
    await target.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  const retained = EXPORT_TABLES.filter(
    (t) => actual.includes(t) && t.startsWith("books_"),
  );
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const table of retained) await target.db.exec(`delete from ${table}`);
  for (const table of retained)
    for (const row of tables[table]) {
      const cols = Object.keys(row);
      await target.db.query(
        `insert into ${table} (${cols.join(",")}) values(${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((c) =>
          row[c] && typeof row[c] === "object"
            ? JSON.stringify(row[c])
            : row[c],
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
  assert.deepEqual(
    verifyNativeAdjustmentArchive(await archive(target), org, 25),
    [],
  );
  assert.deepEqual(await target.prepare({ request: source.request }), p);
  assert.deepEqual(await target.review(), { ...r, created: false });
  await assert.rejects(
    target.db.exec("delete from books_native_journal_lines"),
    /immutable/,
  );
  const q = {
    context: await target.context(),
    draft: {
      ...source.request.draft,
      postingKey: "native-adjustment:" + id(210),
    },
  };
  await assert.rejects(target.prepare({ id: id(210), request: q }), /held/);
  const {
    maker,
    reviewer,
    entity,
    notes,
  } = require("./fixtures/books-native-adjustment-database");
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
    q.context.period.id,
    reviewer,
    id(221),
    held.id,
    "release",
    "Independently release restored native fiscal period",
  ]);
  await target.prepare({ id: id(210), request: q });
  const posted = await target.review({
    fact: id(210),
    id: id(211),
    entry: id(212),
  });
  assert.equal(posted.entry.total_cents, 12000);
  assert.deepEqual(
    verifyNativeAdjustmentArchive(await archive(target), org, 25),
    [],
  );
});
test("native archive follows actual payable and expense roots rather than inventing alternate accounting source tables", async (t) => {
  const f = await setup(t);
  for (const [type, source, fact, review, entry] of [
    ["vendor_bill", 101, 230, 231, 232],
    ["expense", 102, 240, 241, 242],
  ]) {
    const c = await f.context({ type, source: id(source) }),
      request = {
        context: c,
        draft: {
          ...f.request.draft,
          sourceType: type,
          sourceId: id(source),
          postingKey: "native-adjustment:" + id(fact),
        },
      };
    await f.prepare({ id: id(fact), request });
    await f.review({ fact: id(fact), id: id(review), entry: id(entry) });
  }
  assert.deepEqual(
    verifyNativeAdjustmentArchive(await archive(f), org, 25),
    [],
  );
});
