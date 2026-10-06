require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup: fixture,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-native-posting-database");
const {
  buildNativeProjectPostingPlan: build,
} = require("../lib/services/books/native-posting-plan");
function draft(c, v = {}) {
  return {
    entryDate: c.entryDate,
    entryKind: "operational",
    memo: "Actual project invoice native routing",
    postingKey: "invoice:" + c.sourceId + ":s1:v1",
    projectionVersion: 1,
    policyVersion: 1,
    sourceType: c.sourceType,
    sourceId: c.sourceId,
    lines: [
      {
        accountCode: "1100",
        debitCents: 12000,
        creditCents: 0,
        projectId: c.projectId,
      },
      {
        accountCode: "4000",
        debitCents: 0,
        creditCents: 12000,
        projectId: c.projectId,
      },
    ],
    ...v,
  };
}
test("actual source roots route through approved owner, native reviewed chart and fiscal period; balanced plan never adopts legacy account IDs or activates posting", async (t) => {
  const f = await fixture(t),
    c = await f.context(),
    r = build(c, draft(c));
  assert.equal(r.plan.legalEntityId, entity);
  assert.equal(r.plan.totalCents, 12000);
  assert.equal(r.posted, false);
  assert.equal(r.ledgerActivated, false);
  assert.equal(r.plan.periodId, c.period.id);
  assert.equal(c.period.period_number, 4);
  assert.equal(r.plan.chartId, id(30));
  assert.equal(r.plan.ownershipReviewId, id(91));
  assert.ok(
    r.plan.lines.every(
      (l) => l.accountId !== id(500) && l.legalEntityId === entity,
    ),
  );
  assert.deepEqual(build(c, draft(c)), r);
  for (const [type, source] of [
    ["vendor_bill", id(101)],
    ["expense", id(102)],
  ])
    assert.equal((await f.context({ type, source })).sourceId, source);
  assert.equal(
    (await f.db.query("select count(*)::int n from journal_entries")).rows[0].n,
    0,
  );
});
test("missing owner, foreign source/project, unsupported source family and revoked entity grant cannot produce a native context", async (t) => {
  const f = await fixture(t);
  for (const v of [
    { project: id(71) },
    { source: id(999) },
    { org: id(9) },
    { type: "invoice_payment" },
    { date: "2027-01-01" },
    { date: "2025-12-31" },
  ])
    await assert.rejects(f.context(v));
  await f.db.exec(
    `insert into invoices values('${id(110)}','${org}','${id(71)}')`,
  );
  await assert.rejects(
    f.context({ project: id(71), source: id(110) }),
    /Reviewed owner/,
  );
  await f.db.exec(
    `update memberships set status='revoked' where user_id='${maker}'`,
  );
  await assert.rejects(f.context(), /access/);
});
test("plan rejects unbalanced cents, missing entity codes, foreign line projects, split ownership and forged native classifications or chart/calendar/source scope", async (t) => {
  const f = await fixture(t),
    c = await f.context();
  for (const change of [
    (d) => d.lines[0].debitCents++,
    (d) => (d.lines[0].accountCode = "LEGACY-ONLY"),
    (d) => (d.lines[0].projectId = id(71)),
    (d) => (d.lines[0].dimensions = { project_id: id(71) }),
    (d) => (d.lines[0].dimensions = { project_dimensions: { [id(71)]: {} } }),
    (d) => (d.sourceId = id(999)),
    (d) => (d.entryDate = "2026-04-16"),
    (d) => (d.lines[0].debitCents = 1.25),
  ]) {
    const d = draft(c);
    change(d);
    assert.throws(() => build(c, d));
  }
  for (const change of [
    (c) => (c.source.org_id = id(9)),
    (c) => (c.owner.legal_entity_id = id(999)),
    (c) => (c.period.calendar_year_id = id(999)),
    (c) => (c.period.starts_on = "2026-05-01"),
    (c) => (c.chart.definition_sha256 = "f".repeat(64)),
    (c) => (c.accounts[0].definition.legal_entity_id = id(999)),
    (c) => (c.controls[0].account_id = id(999)),
    (c) => c.accounts.push(c.accounts[0]),
  ]) {
    const bad = structuredClone(c);
    change(bad);
    assert.throws(() => build(bad, draft(c)));
  }
});

test("two actual entity owners route semantic roles to distinct canonical codes and independent fiscal calendars", async (t) => {
  const f = await fixture(t),
    other = id(11),
    originalProfile = id(120),
    profile = id(121);
  await f.create(other, originalProfile);
  await f.rpc("prepare_books_legal_entity_profile", [
    org,
    other,
    profile,
    maker,
    originalProfile,
    JSON.stringify({
      legal_name: "Second Builder LLC",
      legal_form: "llc",
      functional_currency: "USD",
      fiscal_start_month: 4,
      fiscal_start_day: 1,
      effective_on: "2026-01-01",
      identity_evidence: { source: "Second original legal entity evidence" },
    }),
    notes,
  ]);
  await f.rpc("review_books_legal_entity_profile", [
    org,
    other,
    profile,
    reviewer,
    notes,
  ]);
  const definition =
    require("../lib/services/books/entity-chart").constructionEntityChart();
  const mapping = { 1100: "ENTITY-B-AR", 4000: "ENTITY-B-REVENUE" };
  for (const a of definition.accounts) {
    a.code = mapping[a.code] ?? a.code;
    if (a.parent_code) a.parent_code = mapping[a.parent_code] ?? a.parent_code;
  }
  for (const role of Object.keys(definition.controls))
    definition.controls[role] =
      mapping[definition.controls[role]] ?? definition.controls[role];
  await f.rpc("prepare_books_entity_chart", [
    org,
    other,
    id(130),
    profile,
    null,
    maker,
    "2026-01-01",
    JSON.stringify(definition),
    notes,
  ]);
  await f.rpc("review_books_entity_chart", [
    org,
    other,
    id(130),
    id(140),
    reviewer,
    notes,
  ]);
  await f.rpc("prepare_books_entity_calendar", [
    org,
    other,
    id(150),
    profile,
    maker,
    2026,
    notes,
  ]);
  await f.rpc("review_books_entity_calendar", [
    org,
    other,
    id(150),
    id(151),
    reviewer,
    notes,
  ]);
  await f.prepare({ project: id(71), entity: other, profile, id: id(92) });
  await f.review({
    project: id(71),
    entity: other,
    proposal: id(92),
    id: id(93),
  });
  await f.db.exec(
    `insert into invoices values('${id(111)}','${org}','${id(71)}')`,
  );
  const a = await f.context(),
    b = await f.context({ project: id(71), source: id(111) });
  assert.equal(a.period.period_number, 4);
  assert.equal(b.period.period_number, 1);
  assert.notEqual(a.period.id, b.period.id);
  assert.throws(() => build(b, draft(b)), /absent/);
  const d = draft(b);
  d.lines[0].accountRole = "accountsReceivable";
  d.lines[1].accountRole = "constructionRevenue";
  const result = build(b, d);
  assert.equal(result.plan.legalEntityId, other);
  assert.equal(result.plan.lines[0].accountCode, "ENTITY-B-AR");
  assert.equal(result.plan.lines[1].accountCode, "ENTITY-B-REVENUE");
  assert.equal(result.plan.lines[0].sourceAccountCode, "1100");
  assert.notEqual(
    result.plan.lines[0].accountId,
    build(a, draft(a)).plan.lines[0].accountId,
  );
});
