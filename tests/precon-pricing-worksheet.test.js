require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  pricingRowSchema,
  pricingWorksheetSchema,
  EMPTY_PRICING_WORKSHEET,
  scopeSignature,
  requestScopeChanged,
  rowPricing,
  worksheetTotals,
  worksheetEstimateLines,
  worksheetQuoteIssues,
} = require("../lib/precon/pricing-worksheet");
const row = (description, cost, extra = {}) =>
  pricingRowSchema.parse({
    id: randomUUID(),
    description,
    unit_cost_cents: cost,
    ...extra,
  });
const sheet = (rows, extra = {}) => ({
  ...EMPTY_PRICING_WORKSHEET,
  rows,
  ...extra,
});
const quote = () => ({
  submission_id: randomUUID(),
  pricing_decision_id: randomUUID(),
  company_name: "Test Electrical",
  normalized_total_cents: 1120000,
  total_cents: 1120000,
  submission_version: 1,
  scope_revision: 1,
  valid_until: null,
  accepted_alternate_ids: [],
  gaps: [],
});

test("unpriced scope remains unknown; a deliberate zero is priced and options stay outside the base", () => {
  const ws = sheet([
    row("Unknown", null),
    row("Included", 0),
    row("Demolition", 400000),
    row("Option", 90000, { is_optional: true }),
  ]);
  assert.equal(worksheetTotals(ws).unpriced, 1);
  assert.equal(worksheetTotals(ws).cost, 400000);
  assert.equal(worksheetTotals(ws).total, 400000);
  assert.equal(rowPricing(ws.rows[0], ws).cost, null);
  assert.equal(rowPricing(ws.rows[1], ws).cost, 0);
});

test("pending bids retain working prices, and a grouped lump sum replaces them exactly once", () => {
  const rows = [
    row("Rough-in", 800000),
    row("Trim-out", 400000),
    row("Demolition", 400000),
  ];
  const request = {
    package_id: randomUUID(),
    row_ids: rows.slice(0, 2).map((row) => row.id),
    scope_signature: scopeSignature(rows.slice(0, 2)),
    quote: null,
  };
  const pending = sheet(rows, { requests: [request] });
  assert.equal(worksheetTotals(pending).cost, 1600000);
  const chosen = sheet(rows, { requests: [{ ...request, quote: quote() }] });
  assert.equal(worksheetTotals(chosen).cost, 1520000);
  assert.equal(rowPricing(rows[1], chosen).covered, true);
  const lines = worksheetEstimateLines(chosen);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].description, "Rough-in · Trim-out");
  assert.equal(lines[0].unit_cost_cents, 1120000);
  assert.equal(
    lines[0].source_bid_submission_id,
    chosen.requests[0].quote.submission_id,
  );
  assert.equal(worksheetTotals({ ...chosen, requests: [] }).cost, 1600000);
});

test("markup, contingency and tax use the same calculation as the published proposal", () => {
  const ws = sheet(
    [
      row("Labour", 3333, { quantity: 3 }),
      row("Fixtures", 50000, { basis: "allowance" }),
    ],
    { markup_percent: 20, contingency_percent: 5, tax_rate: 7 },
  );
  const totals = worksheetTotals(ws);
  assert.equal(totals.cost, 59999);
  assert.equal(totals.subtotal, 71999);
  assert.equal(totals.contingency, 3600);
  assert.equal(totals.tax, 5292);
  assert.equal(totals.total, 80891);
  assert.equal(worksheetEstimateLines(ws)[1].is_allowance, true);
});

test("quote checks detect price revisions, expiry/withdrawal absence, and changed scope without mistaking a rate edit for scope", () => {
  const rows = [row("Electrical", 1200000)];
  const selected = quote();
  const request = {
    package_id: randomUUID(),
    row_ids: [rows[0].id],
    scope_signature: scopeSignature(rows),
    quote: selected,
  };
  const ws = sheet(rows, { requests: [request] });
  const offers = [{ ...selected, bid_package_id: request.package_id }];
  assert.deepEqual(worksheetQuoteIssues(ws, offers), []);
  assert.equal(worksheetQuoteIssues(ws, []).length, 1);
  assert.equal(
    worksheetQuoteIssues(ws, [
      { ...offers[0], pricing_decision_id: randomUUID() },
    ]).length,
    1,
  );
  assert.equal(
    requestScopeChanged(request, [{ ...rows[0], unit_cost_cents: 1000000 }]),
    false,
  );
  assert.equal(
    requestScopeChanged(request, [{ ...rows[0], quantity: 2 }]),
    true,
  );
  assert.equal(
    requestScopeChanged(request, [{ ...rows[0], notes: "Add panel" }]),
    true,
  );
});

test("overlapping coverage, mixed optionality and inconsistent lump-sum markup cannot be persisted", () => {
  const rows = [row("A", 100), row("B", 200)];
  const request = {
    package_id: randomUUID(),
    row_ids: rows.map((row) => row.id),
    scope_signature: scopeSignature(rows),
    quote: quote(),
  };
  assert.equal(
    pricingWorksheetSchema.safeParse(sheet(rows, { requests: [request] }))
      .success,
    true,
  );
  assert.equal(
    pricingWorksheetSchema.safeParse(
      sheet(rows, {
        requests: [request, { ...request, package_id: randomUUID() }],
      }),
    ).success,
    false,
  );
  assert.equal(
    pricingWorksheetSchema.safeParse(
      sheet([rows[0], { ...rows[1], is_optional: true }], {
        requests: [request],
      }),
    ).success,
    false,
  );
  assert.equal(
    pricingWorksheetSchema.safeParse(
      sheet([rows[0], { ...rows[1], markup_pct: 10 }], { requests: [request] }),
    ).success,
    false,
  );
  assert.equal(
    pricingWorksheetSchema.safeParse(
      sheet(rows, { requests: [{ ...request, row_ids: [randomUUID()] }] }),
    ).success,
    false,
  );
});

