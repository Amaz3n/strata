// WIP-01 — cost-to-cost percentage of completion, driven through the product's
// own services: source RPCs, the real projector, period/WIP review and close.
const { randomUUID } = require("node:crypto")

async function policyWorkedExample(kit, expected, check) {
  const { CONSTRUCTION_CHART_TEMPLATE } = require("../../../lib/services/books/chart-of-accounts")
  const { projectJournal } = require("../../../lib/services/books/projector")
  const { createAccountingPeriod, closeAccountingPeriod } = require("../../../lib/services/books/period-close")
  const { prepareWipSnapshot, getWipReviewWorkspace, reviewWipSnapshots } = require("../../../lib/services/books/wip-review")
  const { launchGreenfieldBooks, GREENFIELD_ATTESTATION } = require("../../../lib/services/books/greenfield")
  const { createProjectVendorBill, approveVendorBillsAtomic } = require("../../../lib/services/vendor-bills")
  const { q, sql } = kit
  const input = expected.inputs
  const { orgId, owner, reviewer } = kit.organization({ name: "WIP-01 worked example", chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant" })
  const projectId = randomUUID(),
    vendorId = randomUUID(),
    costCodeId = randomUUID(),
    contractId = randomUUID()
  sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(projectId)},${q(orgId)},'Custom home — worked example','residential',${q(owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(orgId)},${q(projectId)}) on conflict do nothing;
insert into public.companies(id,org_id,name) values(${q(vendorId)},${q(orgId)},'Worked example framing');
insert into public.cost_codes(id,org_id,code,name) values(${q(costCodeId)},${q(orgId)},'06-100','Rough carpentry');
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(contractId)},${q(orgId)},${q(projectId)},'Fixed-price construction contract','active',${input.contractCents},'usd','fixed',${input.retainagePercent},'2026-07-01');
commit;`)

  // A Books-only builder: periods, then a greenfield launch with a zero opening.
  const periods = []
  for (const month of input.months) {
    const [year, mm] = month.period.split("-").map(Number)
    const last = new Date(Date.UTC(year, mm, 0)).getUTCDate()
    const periodStart = `${month.period}-01`,
      periodEnd = `${month.period}-${String(last).padStart(2, "0")}`
    periods.push({ periodStart, periodEnd, periodId: await kit.as(owner, () => createAccountingPeriod({ periodStart, periodEnd, fiscalYear: year, fiscalPeriod: mm })) })
  }
  await kit.as(owner, () => launchGreenfieldBooks({ launchedOn: periods[0].periodStart, openingPosition: "zero", attestation: GREENFIELD_ATTESTATION }))

  for (const [index, month] of input.months.entries()) {
    const { periodStart, periodEnd, periodId } = periods[index]
    const bill = await kit.as(owner, () => createProjectVendorBill({ projectId, input: {
      company_id: vendorId, bill_number: `WIP-B${index + 1}`, bill_date: `${month.period}-10`, due_date: `${month.period}-25`,
      total_cents: month.billCents, actual_lines: [{ cost_code_id: costCodeId, description: "Framing", amount_cents: month.billCents, project_id: projectId }],
    } }))
    await kit.as(owner, () => approveVendorBillsAtomic([{ id: bill.id }]))
    await kit.drainOutbox(orgId)
    sql(`begin;
select public.create_invoice_atomic(${q(orgId)},jsonb_build_object('project_id',${q(projectId)},'invoice_number',${q(`WIP-I${index + 1}`)},
  'title','Progress billing','issue_date',${q(`${month.period}-20`)},'due_date',${q(`${month.period}-28`)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${month.invoiceGrossCents - month.invoiceRetainageCents},'tax_cents',0,
  'total_cents',${month.invoiceGrossCents - month.invoiceRetainageCents},'balance_due_cents',${month.invoiceGrossCents - month.invoiceRetainageCents},'token',${q(randomUUID())},
  'metadata',jsonb_build_object('retainage_amount_cents',${month.invoiceRetainageCents},'source_contract_id',${q(contractId)})),
  -- Invoice totals are NET: the hold is a negative retainage line (lib/services/retainage.ts).
  jsonb_build_array(jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${month.invoiceGrossCents},'amount_cents',${month.invoiceGrossCents}),
    jsonb_build_object('description','Retainage held','quantity',1,'unit','retainage','unit_price_cents',${-month.invoiceRetainageCents},'amount_cents',${-month.invoiceRetainageCents})));
commit;`)
    await kit.service(() => projectJournal(orgId, { full: true }))

    await kit.as(owner, () => prepareWipSnapshot({
      periodId, projectId, originalContractCents: input.contractCents, approvedChangeOrdersCents: 0,
      eacCents: input.estimatedTotalCostCents, note: "Worked example: contract and estimate per the reviewed policy fixture.",
    }))
    const workspace = await kit.as(reviewer, () => getWipReviewWorkspace(periodId))
    await kit.as(reviewer, () => reviewWipSnapshots({ periodId, snapshots: workspace.snapshots, note: "Independent review of the worked-example WIP position." }))
    await kit.as(owner, () => closeAccountingPeriod(periodId))

    const label = index === 0 ? "afterJuly" : "afterAugust"
    check.equal(`${month.period} ledger matches the policy entry set`, expected.expectedNetDebitCentsByAccount[label], kit.postedNet(orgId))
    const recognized = kit.rows(`select coalesce(sum(l.credit_cents - l.debit_cents),0)::bigint cents from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
      join public.gl_accounts a on a.id=l.account_id where l.org_id=${q(orgId)} and a.code='4000' and e.status in ('posted','reversed') and e.entry_date between ${q(periodStart)} and ${q(periodEnd)}`)[0].cents
    check.equal(`${month.period} recognition delta`, expected.expectedRecognitionCents[month.period], Number(recognized))
  }
  const net = kit.postedNet(orgId)
  check.equal("gross profit after August", expected.expectedGrossProfitCentsAfterAugust, -(net["4000"] ?? 0) - (net["5000"] ?? 0))
  return { orgId, projectId }
}

module.exports = {
  id: "WIP-01",
  subcases: { "policy-worked-example": policyWorkedExample },
}
