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
} = require("./fixtures/books-native-invoice-economic-database");
const {
  buildNativeInvoicePostingPlan: build,
  verifyNativeInvoiceEconomicContext: verify,
  nativeInvoiceLineCents: cents,
} = require("../lib/services/books/native-invoice-economics");
test("native invoice derives exact progress billing from actual tax, retainage and decimal lines; repeated snapshots preserve monetary posting identity", async (t) => {
  const f = await setup(t),
    a = build(await f.economic()),
    b = build(await f.economic());
  assert.equal(a.disposition, "progress_billing");
  assert.equal(a.plan.totalCents, 12000);
  assert.equal(a.plan.postingKey, b.plan.postingKey);
  await f.db.exec(
    'alter table invoices add column updated_at timestamptz default now();update invoices set updated_at=clock_timestamp(),metadata=metadata || \'{"harmless_label":"Updated operational note"}\'::jsonb',
  );
  assert.equal(build(await f.economic()).plan.postingKey, a.plan.postingKey);
  const amounts = a.plan.lines.map((l) => [
    l.accountCode,
    l.debitCents,
    l.creditCents,
  ]);
  assert.deepEqual(amounts, [
    ["1100", 10000, 0],
    ["1110", 2000, 0],
    ["2350", 0, 11000],
    ["2250", 0, 1000],
  ]);
  assert.equal(a.posted, false);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_native_journal_entries",
      )
    ).rows[0].n,
    0,
  );
  for (const [q, p, result] of [
    ["1.005", "100", 101],
    ["-1.005", "100", -101],
    ["0.000001", "500000", 1],
    ["2.5", "3", 8],
  ])
    assert.equal(cents(q, p), result);
  for (const [q, p] of [
    ["1e3", "100"],
    ["NaN", "1"],
    ["1.0000001", "1"],
    ["1", "9007199254740992"],
  ])
    assert.throws(() => cents(q, p));
});
test("native closing recognizes income only with exact completed settlement; selected accounts must belong to the entity income chart", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    `update projects set property_type='production';update contracts set contract_type='purchase_agreement';update invoices set metadata='{"invoice_kind":"closing","source_closing_id":"${id(610)}"}';insert into closings values('${id(610)}','${org}','${id(70)}','${id(100)}','closed','2026-04-15','{"finalPriceCents":12000}')`,
  );
  const settlement = {
    ...require("../lib/financials/purchase-agreement-pricing").buildPurchaseAgreementSettlement(
      {
        agreementTotalCents: 12000,
        approvedChangeOrders: [],
        adjustments: [],
        deposits: [],
        builtAt: new Date().toISOString(),
      },
    ),
    contractId: id(601),
    agreementEvidenceDigest: "a".repeat(64),
    agreement: {
      id: id(601),
      number: "PA-1",
      signed_at: "2026-01-01T00:00:00Z",
    },
    pricing: {
      basePriceCents: 12000,
      lotPremiumCents: 0,
      structuralOptions: [],
      designSelections: [],
      incentives: [],
      structuralOptionsCents: 0,
      designSelectionsCents: 0,
      incentivesCents: 0,
      totalCents: 12000,
    },
    changeOrders: [],
  };
  await f.db.query("update closings set settlement=$1", [
    JSON.stringify(settlement),
  ]);
  await f.db.query(
    "update invoices set total_cents=12000,tax_cents=0,metadata=metadata || jsonb_build_object('settlement',$1::jsonb)",
    [JSON.stringify(settlement)],
  );
  await f.db.exec(
    "delete from retainage;delete from invoice_lines where unit_price_cents<0;update invoice_lines set unit_price_cents=12000",
  );
  const e = await f.economic(),
    income = e.native.accounts.find((a) => a.code === "4900");
  await f.db.query("update invoice_lines set metadata=$1 where id=$2", [
    JSON.stringify({ arc_books_entity_account_id: income.id }),
    id(602),
  ]);
  const p = build(await f.economic());
  assert.equal(p.disposition, "closing_revenue");
  assert.equal(p.plan.lines[1].accountId, income.id);
  await f.db.exec("update closings set status='cleared_to_close'");
  assert.throws(
    () =>
      build({
        ...p.economic,
        closings: p.economic.closings.map((c) => ({
          ...c,
          status: "cleared_to_close",
        })),
      }),
    /completed settlement/,
  );
  const bad = structuredClone(p.economic);
  bad.lines[0].source.metadata = {
    arc_books_entity_account_id: p.economic.native.accounts.find(
      (a) => a.code === "1100",
    ).id,
  };
  assert.throws(() => build(bad), /income account/);
  bad.lines[0].source.metadata = { arc_books_gl_account_id: id(500) };
  assert.throws(() => build(bad), /Legacy income/);
});
test("native retainage release creates only AR against original retainage and deposit requests create no journal", async (t) => {
  const f = await setup(t);
  await f.db.exec(
    `insert into invoices(id,org_id,project_id,issue_date,total_cents,tax_cents) values('${id(103)}','${org}','${id(70)}','2026-04-16',2000,0);update retainage set release_invoice_id='${id(103)}'`,
  );
  const e = await f.economic({ source: id(103), date: "2026-04-16" }),
    p = build(e);
  assert.equal(p.disposition, "retainage_release");
  assert.deepEqual(
    p.plan.lines.map((l) => [l.accountCode, l.debitCents, l.creditCents]),
    [
      ["1100", 2000, 0],
      ["1110", 0, 2000],
    ],
  );
  const bad = structuredClone(e);
  bad.originalInvoices = [];
  assert.throws(() => build(bad), /original project retainage/);
  await f.db.exec(
    'update invoices set metadata=\'{"invoice_kind":"earnest_deposit"}\' where total_cents=10000',
  );
  const d = build(await f.economic());
  assert.equal(d.disposition, "collection_request");
  assert.equal(d.plan, null);
});
test("native invoice economic witness refuses forged scope, unapproved policy, hold, date drift and untied priced totals", async (t) => {
  const f = await setup(t),
    e = await f.economic();
  for (const corrupt of [
    (b) => (b.policy.org_id = id(9)),
    (b) => (b.policy.approved_by = maker),
    (b) => (b.settings.active_policy_version = 2),
    (b) => (b.lines[0].source.invoice_id = id(999)),
    (b) => (b.retainage[0].project_id = id(71)),
    (b) => (b.native.source.issue_date = "2026-04-16"),
    (b) => (b.lines[0].unitPriceCents = "11001"),
    (b) => b.contracts.push({ ...b.contracts[0] }),
  ]) {
    const b = structuredClone(e);
    corrupt(b);
    assert.throws(() => build(b));
  }
  await f.rpc("set_books_native_period_hold", [
    org,
    entity,
    e.native.period.id,
    maker,
    id(620),
    null,
    "hold",
    notes,
  ]);
  assert.throws(
    () =>
      build({
        ...e,
        postingHold: {
          id: id(620),
          org_id: org,
          legal_entity_id: entity,
          period_id: e.native.period.id,
          decision: "hold",
        },
      }),
    /held/,
  );
  await f.db.exec("update accounting_policies set status='draft'");
  await assert.rejects(f.economic(), /approved Books policy/);
  await assert.rejects(f.economic({ project: id(71) }));
  const bad = structuredClone(e);
  bad.lines[0].source.cost_code_id = id(999);
  assert.throws(() => verify(bad), /cost-code/);
});
