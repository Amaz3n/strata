require('../scripts/register-ts-node-test')
const test = require('node:test'), assert = require('node:assert/strict')
const { fixture, id, org } = require('./helpers/books-payroll-register-fixture')
const { reconcilePayrollImport } = require('../lib/services/books/payroll-import-rules')
const { payrollConstructionImpact } = require('../lib/services/books/payroll-construction-impact')
function scenario() {
  const f = fixture(), allocation = f.run.employees[0].allocations[0]
  allocation.labor_evidence_ids = [id(10)]
  f.labor = [{ id: id(10), org_id: org, worker_id: id(2), project_id: id(4), cost_code_id: id(5), account_code: '5030', incurred_on: '2026-09-10',
    fact_id: id(11), journal_id: id(12), source_revision: '2026-09-10T12:00:00Z', gross_cents: 24000, estimated_burden_cents: 12000, cost_cents: 36000, clearing_cents: 36000 }]
  f.cost = { id: id(10), org_id: org, project_id: id(4), cost_code_id: id(5), source_type: 'time_entry', source_id: id(13), status: 'posted', cost_cents: 36000, incurred_on: '2026-09-10',
    budget_line_id: id(14), gmp_classification: 'outside_gmp', billable_cost_id: id(16) }
  f.billable = { id: id(16), org_id: org, project_id: id(4), cost_code_id: id(5), source_type: 'time_entry', source_id: id(13), status: 'billed', is_billable: true, invoice_id: id(17),
    cost_cents: 36000, markup_cents: 4000, billable_cents: 40000, markup_percent_resolved: '11.1111', metadata: { billing_method: 'time_and_materials_rate', bill_rate_cents: 5000, hours: 8 } }
  f.tables = { job_cost_entries: [f.cost], budget_lines: [{ id: id(14), org_id: org, budget_id: id(15), cost_code_id: id(5) }],
    budgets: [{ id: id(15), org_id: org, project_id: id(4) }], billable_costs: [f.billable] }
  return f
}
const plan = f => payrollConstructionImpact(reconcilePayrollImport(f.run, f.labor, f.postingAccounts), f.labor, f.tables)
test('actual burden replaces the native estimate with signed project costs and preserves original budget/GMP attribution', () => {
  const f = scenario(), before = JSON.stringify(f), result = plan(f), row = result.allocations[0]
  assert.equal(row.originalCostCents, 36000); assert.equal(row.actualCostCents, 27000); assert.equal(row.costDeltaCents, -9000)
  assert.equal(row.budgetLineId, id(14)); assert.equal(row.gmpClassification, 'outside_gmp'); assert.deepEqual(row.blockers, [])
  assert.deepEqual(row.jobCostCorrections.map(x => [x.component, x.costCents]), [['estimated_burden_release', -12000], ['employer_taxes', 2500], ['employer_benefits', 500]])
  assert.equal(result.projectCostDeltaCents, -9000); assert.equal(result.overheadCostDeltaCents, 0)
  assert.equal(result.previewOnly, true); assert.equal(result.postingImplemented, false)
  assert.equal(JSON.stringify(f), before, 'preview never modifies original wages, costs or invoices')
})
test('T&M customer rates survive actual-payroll corrections even when original costs are billed', () => {
  const f = scenario(), row = plan(f).allocations[0]
  assert.equal(row.billing.action, 'preserve_time_and_materials_rates'); assert.equal(row.billing.customerAmountDeltaCents, 0)
  assert.equal(row.billing.requiresReview, false); assert.deepEqual(row.billing.protectedBillableCostIds, [id(16)])
  assert.deepEqual(row.billing.originalSources[0].metadata, f.billable.metadata)
  assert.equal(f.billable.billable_cents, 40000)
})
test('cost-plus correction keeps frozen billing evidence and requires a review without inventing markup or rewriting invoices', () => {
  const f = scenario(); f.billable.metadata.billing_method = 'cost_plus_markup'
  for (const status of ['open', 'locked', 'billed', 'excluded', 'voided']) {
    f.billable.status = status; f.billable.invoice_id = status === 'billed' ? id(17) : null
    const row = plan(f).allocations[0]
    assert.equal(row.billing.action, 'review_cost_plus_correction'); assert.equal(row.billing.customerAmountDeltaCents, null)
    assert.equal(row.billing.requiresReview, true); assert.equal(row.billing.originalSources[0].markup_percent_resolved, '11.1111')
    assert.equal(row.billing.protectedBillableCostIds.length, ['locked', 'billed'].includes(status) ? 1 : 0)
  }
})
test('offsetting wage and burden variances keep their separate cost components at zero net change', () => {
  const f = scenario(); f.labor[0].gross_cents = 23000; f.labor[0].estimated_burden_cents = 4000
  f.labor[0].cost_cents = f.labor[0].clearing_cents = f.cost.cost_cents = 27000
  const row = plan(f).allocations[0]
  assert.equal(row.costDeltaCents, 0); assert.equal(row.components[0].component, 'gross_variance'); assert.equal(row.components[0].costCents, 1000)
  assert.equal(row.jobCostCorrections.length, 4, 'do not hide different wage/burden economics by netting')
})
test('overhead stays out of project job cost; capitalized construction wages stay in their asset account', () => {
  const f = fixture(); f.labor = []; f.tables = { job_cost_entries: [], budgets: [], budget_lines: [], billable_costs: [] }
  f.run.employees[0].allocations[0].project_id = null
  let row = plan(f).allocations[0]
  assert.deepEqual(row.jobCostCorrections, []); assert.equal(row.billing.action, 'overhead_only'); assert.equal(row.billing.customerAmountDeltaCents, 0)
  assert.equal(plan(f).overheadCostDeltaCents, 27000)
  f.run.employees[0].allocations[0].project_id = id(4); f.run.employees[0].allocations[0].cost_account_code = '1500'
  f.postingAccounts.push({ id: id(19), org_id: org, code: '1500', account_type: 'asset', subtype: 'work_in_progress', active: true })
  row = plan(f).allocations[0]; assert.equal(row.accountCode, '1500'); assert.equal(row.actualCostCents, 27000)
  assert.ok(row.blockers.includes('new_project_cost_requires_budget_and_gmp_allocation'))
})
test('missing metadata and mixed budgets require allocation review; no default budget or inside-GMP assumption', () => {
  const f = scenario(); delete f.cost.budget_line_id; delete f.cost.gmp_classification
  let row = plan(f).allocations[0]
  assert.ok(row.blockers.includes('review_budget_allocation')); assert.ok(row.blockers.includes('review_gmp_allocation'))
  assert.equal(row.budgetLineId, null); assert.equal(row.gmpClassification, null)
  const g = scenario(); g.run.employees[0].allocations[0].labor_evidence_ids.push(id(20))
  for (const row of [g.labor[0], g.cost]) { row.cost_cents = 18000 }
  g.labor[0].gross_cents = 12000; g.labor[0].estimated_burden_cents = 6000; g.labor[0].clearing_cents = 18000
  g.labor.push({ ...g.labor[0], id: id(20), fact_id: id(21), journal_id: id(22) })
  g.tables.job_cost_entries.push({ ...g.cost, id: id(20), source_id: id(23), budget_line_id: null, gmp_classification: 'inside_gmp', billable_cost_id: null })
  row = plan(g).allocations[0]
  assert.ok(row.blockers.includes('review_budget_allocation')); assert.ok(row.blockers.includes('review_gmp_allocation'))
  assert.equal(row.billing.action, 'review_billing_basis'); assert.equal(row.billing.customerAmountDeltaCents, null)
})
test('foreign/moved/duplicated sources and inconsistent generated billing amounts fail closed', () => {
  for (const mutate of [f => f.cost.org_id = id(90), f => f.cost.project_id = id(90), f => f.cost.cost_cents++,
    f => f.tables.job_cost_entries.push({ ...f.cost }), f => f.billable.org_id = id(90), f => f.billable.project_id = id(90),
    f => f.billable.billable_cents++, f => f.cost.billable_cost_id = id(90), f => f.tables.billable_costs.push({ ...f.billable, id: id(90) })]) {
    const f = scenario(); mutate(f); assert.throws(() => plan(f))
  }
  const f = scenario(); f.tables.budgets[0].project_id = id(90)
  assert.ok(plan(f).allocations[0].blockers.includes('review_budget_source_scope'))
})
test('missing snapshot populations and billable links are surfaced as blockers, not silent non-billable corrections', () => {
  const f = scenario(); delete f.tables.budget_lines; f.tables.billable_costs = []
  const row = plan(f).allocations[0]
  assert.ok(row.blockers.includes('missing_budget_lines')); assert.ok(row.blockers.includes('missing_original_billable_cost'))
  assert.equal(row.billing.action, 'review_billing_basis'); assert.equal(row.billing.customerAmountDeltaCents, null)
})
test('payroll cannot backdate the construction correction before its native wages were incurred', () => {
  const f = scenario(); f.run.accrual_date = '2026-09-05'
  assert.ok(plan(f).allocations[0].blockers.includes('payroll_accrual_precedes_native_cost'))
})
test('INT32 job-cost capacity is enforced even when the provider and journal accept safe integer cents', () => {
  const f = fixture(); f.labor = []; f.tables = { job_cost_entries: [], budgets: [], budget_lines: [], billable_costs: [] }
  const amount = 2147483648
  f.run.employees[0].gross_cents = f.run.employees[0].net_cents = amount
  f.run.employees[0].employee_taxes_cents = f.run.employees[0].employee_deductions_cents = 0
  f.run.employees[0].allocations[0].gross_cents = amount
  Object.assign(f.run.controls, { gross_cents: amount, net_cents: amount, employee_taxes_cents: 0, employee_deductions_cents: 0, funding_cents: amount + 3000 })
  assert.ok(plan(f).allocations[0].blockers.includes('job_cost_integer_capacity'))
})
test('a balanced journal that reallocates cost across projects cannot pass the GL-to-job-cost bridge', () => {
  const f = scenario(), result = reconcilePayrollImport(f.run, f.labor, f.postingAccounts)
  for (const line of result.draft.lines) if (line.accountCode === '5030') line.projectId = id(90)
  assert.throws(() => payrollConstructionImpact(result, f.labor, f.tables), /ledger cost bucket/)
})
test('cross-project cost decreases and increases retain their own amounts rather than an organization-wide net adjustment', () => {
  const f = scenario(), first = f.run.employees[0].allocations[0]
  first.gross_cents = 12000; first.employer_taxes_cents = 1250; first.employer_benefits_cents = 250
  f.run.employees[0].allocations.push({ ...first, id: id(24), project_id: id(25), cost_code_id: id(26), labor_evidence_ids: [] })
  const result = plan(f)
  assert.deepEqual(result.allocations.map(row => [row.projectId, row.costDeltaCents]), [[id(4), -22500], [id(25), 13500]])
  assert.equal(result.projectCostDeltaCents, -9000)
  assert.ok(result.allocations[1].blockers.includes('new_project_cost_requires_budget_and_gmp_allocation'))
  f.run.employees[0].allocations.reverse(); assert.equal(plan(f).digest, result.digest)
})
test('source order is irrelevant, while budget and frozen billing economics change the plan digest', () => {
  const f = scenario(), original = plan(f)
  f.tables.job_cost_entries.reverse(); f.tables.billable_costs.reverse(); assert.equal(plan(f).digest, original.digest)
  f.billable.markup_percent_resolved = '12'; assert.notEqual(plan(f).digest, original.digest)
  f.billable.markup_percent_resolved = '11.1111'; f.cost.gmp_classification = 'inside_gmp'; assert.notEqual(plan(f).digest, original.digest)
  assert.equal(plan(f).allocations[0].jobCostCorrections[0].sourceKey, original.allocations[0].jobCostCorrections[0].sourceKey)
})
