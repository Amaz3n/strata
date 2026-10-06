require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const {
  setup,
  id,
  org,
} = require("./fixtures/books-native-invoice-correction-database");
const {
  verifyNativeInvoicePostingReceipt,
} = require("../lib/services/books/native-invoice-posting-receipt");
const {
  verifyNativeInvoiceCorrectionProposal,
} = require("../lib/services/books/native-invoice-correction-proposal");
const {
  archive,
  bundle,
  restore,
} = require("./fixtures/books-native-invoice-correction-archive");
const {
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
test("actual old decimal transport fails snapshot validation; canonical numeric view keeps exact quantity and permits native posting", async (t) => {
  const base = require("./fixtures/books-native-invoice-income-database"),
    f = await base.setup(t);
  // Retain the observed failure against the actual prior reader before upgrading.
  const prior = fs
    .readFileSync(
      "supabase/migrations/20261005021730_books_native_invoice_economic_context.sql",
      "utf8",
    )
    .replace(
      "create function public.read_books_native_invoice_economic_context(",
      "create or replace function public.read_books_native_invoice_economic_context(",
    );
  await f.db.exec(prior);
  await f.db.exec(
    "update invoice_lines set quantity=100000000000.123456,unit_price_cents=1 where unit_price_cents=11000;update invoices set total_cents=99999999000",
  );
  const old = await f.economic();
  assert.equal(old.lines[0].quantity, "100000000000.123456");
  assert.equal(old.lines[0].source.quantity, 100000000000.12346);
  await assert.rejects(f.post({ economic: old }), /snapshot changed/);
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005120313_books_native_invoice_exact_quantity_transport.sql",
      "utf8",
    ),
  );
  const economic = await f.economic(),
    r = await f.post({ economic });
  const verified = verifyNativeInvoicePostingReceipt(
    r.posting,
    r.entry,
    r.lines,
  );
  assert.equal(
    verified.original.economic.lines[0].quantity,
    "100000000000.123456",
  );
  assert.equal(r.entry.total_cents, 100000001000);
  assert.deepEqual(await f.post({ economic }), { ...r, created: false });
  assert.equal(
    (
      await f.db.query(
        "select quantity::text q from invoice_lines where id=$1",
        [id(602)],
      )
    ).rows[0].q,
    "100000000000.123456",
  );
});
test("large fractional replacement persists exact pricing, survives full scoped archive/restore, and retries without editing original source", async (t) => {
  const source = await setup(t),
    target = await setup(t),
    economic = await source.economic({ date: "2026-04-16" });
  const request = {
    ...source.request,
    id: id(997),
    protocolVersion: 2,
    intent: "replace",
    context: economic.native,
    baseEconomic: economic,
    patch: {
      totalCents: 99999999000,
      taxCents: 1000,
      lines: [
        {
          id: id(602),
          quantity: "100000000000.123456",
          unitPriceCents: 1,
          incomeAccountId: null,
        },
      ],
    },
  };
  const r = await source.prepare(request),
    v = verifyNativeInvoiceCorrectionProposal(r.proposal);
  assert.equal(
    v.pair.replacementEconomic.lines[0].quantity,
    "100000000000.123456",
  );
  assert.equal(v.pair.replacement.totalCents, 100000001000);
  assert.equal(
    (
      await source.db.query(
        "select quantity::text q from invoice_lines where id=$1",
        [id(602)],
      )
    ).rows[0].q,
    "1",
  );
  const tables = await archive(source),
    report = verifyBooksExportBundle(bundle(tables, 31));
  assert.equal(report.valid, true, JSON.stringify(report));
  await restore(target, tables);
  assert.deepEqual(await target.prepare(request), { ...r, created: false });
  assert.equal(
    (
      await target.db.query(
        "select quantity::text q from invoice_lines where id=$1",
        [id(602)],
      )
    ).rows[0].q,
    "1",
  );
  const recaptured = await target.rpc("capture_books_export_snapshot", [org]);
  assert.equal(
    recaptured.tables.books_native_invoice_correction_proposals.length,
    1,
  );
});
test("posted exact decimal source survives real export, archive validation, restore and original retry", async (t) => {
  const source = await setup(t, async (f) => {
    await f.db.exec(
      "update invoice_lines set quantity=100000000000.123456,unit_price_cents=1 where unit_price_cents=11000;update invoices set total_cents=99999999000",
    );
  });
  const target = await setup(t);
  const catalog = fs.readFileSync(
    "supabase/tests/books_invoice_quantity_export_text.test.sql",
    "utf8",
  );
  const conditions = [
    ...catalog.matchAll(/select ok\(([\s\S]*?),('(?:[^']|'')*')\);/g),
  ];
  assert.equal(conditions.length, 3);
  for (const [, expression, label] of conditions)
    assert.equal(
      (await source.db.query(`select (${expression}) as ok`)).rows[0].ok,
      true,
      label,
    );
  const captured = await source.rpc("capture_books_export_snapshot", [org]);
  assert.equal(
    captured.tables.invoice_lines.find((l) => l.id === id(602)).quantity,
    "100000000000.123456",
  );
  const tables = await archive(source);
  assert.deepEqual(tables.invoice_lines, captured.tables.invoice_lines);
  const report = verifyBooksExportBundle(bundle(tables, 31));
  assert.equal(report.valid, true, JSON.stringify(report));
  const altered = structuredClone(tables);
  altered.invoice_lines.find((l) => l.id === id(602)).quantity =
    "100000000000.123457";
  assert.equal(verifyBooksExportBundle(bundle(altered, 31)).valid, false);
  const rounded = structuredClone(tables);
  rounded.invoice_lines.find((l) => l.id === id(602)).quantity =
    100000000000.12346;
  assert.equal(verifyBooksExportBundle(bundle(rounded, 31)).valid, false);
  assert.equal(verifyBooksExportBundle(bundle(rounded, 30)).valid, false);
  await restore(target, tables);
  assert.equal(
    (
      await target.db.query(
        "select quantity::text q from invoice_lines where id=$1",
        [id(602)],
      )
    ).rows[0].q,
    "100000000000.123456",
  );
  assert.equal(
    (await target.economic()).lines[0].quantity,
    "100000000000.123456",
  );
  const original = verifyNativeInvoicePostingReceipt(
    source.money.posting,
    source.money.entry,
    source.money.lines,
  );
  assert.deepEqual(
    await target.post({ economic: original.original.economic }),
    {
      ...source.money,
      created: false,
    },
  );
});

test("real legacy ownership population remains byte-exact across export transport upgrade", async (t) => {
  const base = require("./fixtures/books-legacy-entity-database"),
    f = await base.setup(t);
  await f.db.exec("alter table invoice_lines add column quantity numeric");
  await f.db.query(
    "insert into invoice_lines(id,org_id,quantity) values($1,$2,100000000000.123456)",
    [base.id(999), base.org],
  );
  const before = await f.db.query(
    "select capture_books_legacy_ownership_evidence($1,$2) s",
    [base.org, base.actor],
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261005121818_books_invoice_quantity_export_text.sql",
      "utf8",
    ),
  );
  const after = await f.db.query(
    "select capture_books_legacy_ownership_evidence($1,$2) s",
    [base.org, base.actor],
  );
  assert.equal(after.rows[0].s.populationText, before.rows[0].s.populationText);
  assert.match(after.rows[0].s.populationText, /100000000000\.123456/);
  const exported = await f.db.query(
    "select capture_books_export_snapshot($1) s",
    [base.org],
  );
  assert.equal(
    exported.rows[0].s.tables.invoice_lines[0].quantity,
    "100000000000.123456",
  );
});
