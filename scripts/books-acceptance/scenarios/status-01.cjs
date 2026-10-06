// STATUS-01 — posting status stays honest through every kind of source edit,
// driven through the product's bill services, projection job and close.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, contractJob, project } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers

async function jobOrg(kit, name, periods) {
  const ids = { projectId: randomUUID(), secondProjectId: randomUUID(), vendorId: randomUUID(), costCodeId: randomUUID(), secondCostCodeId: randomUUID() }
  return greenfieldOrg(kit, { name, periods, setup: (org) => {
    Object.assign(org, ids)
    const { q } = kit
    kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(org.projectId)},${q(org.orgId)},'STATUS-01 first job','residential',${q(org.owner.userId)}),(${q(org.secondProjectId)},${q(org.orgId)},'STATUS-01 second job','residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(org.projectId)}),(${q(org.orgId)},${q(org.secondProjectId)}) on conflict do nothing;
insert into public.companies(id,org_id,name) values(${q(org.vendorId)},${q(org.orgId)},'Framing subcontractor');
insert into public.cost_codes(id,org_id,code,name) values(${q(org.costCodeId)},${q(org.orgId)},'06-100','Rough carpentry'),(${q(org.secondCostCodeId)},${q(org.orgId)},'06-200','Finish carpentry');
commit;`)
  } })
}

const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id

async function createBill(kit, org, billDate, cents) {
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: {
    company_id: org.vendorId, bill_number: `ST-${randomUUID().slice(0, 6)}`, bill_date: billDate, due_date: billDate, total_cents: cents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: cents, project_id: org.projectId }],
  } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.drainOutbox(org.orgId)
  return created.id
}

// Edits go through the product's bill update; lines are restated in full.
function editBill(kit, org, billId, input) {
  return kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId, input: { status: "approved", ...input } }))
}

async function projectionJob(kit, org) {
  const { recordProjectionFailures } = app("books/reconciliation")
  const result = await project(kit, org)
  await kit.service(() => recordProjectionFailures([{ orgId: org.orgId, ...result }], { full: true }))
}

const state = (kit, org, billId) => kit.as(org.owner, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "vendor_bill", sourceId: billId })).then((status) => status?.state)
const entryCount = (kit, org) => Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)}`)[0].n)
const reversedCount = (kit, org) => Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)} and status='reversed'`)[0].n)
const openFindings = (kit, org, billId) => kit.rows(`select category, details->>'href' href from public.accounting_reconciliation_items where org_id=${kit.q(org.orgId)} and entity_type='vendor_bill' and entity_id=${kit.q(billId)} and status<>'resolved'`)

async function harmlessEdit(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "STATUS-01 harmless edit", ["2026-07"])
  const billId = await createBill(kit, org, input.billDate, input.cents)
  await projectionJob(kit, org)
  const before = entryCount(kit, org)
  await editBill(kit, org, billId, { due_date: input.newDueDate })
  await projectionJob(kit, org)
  check.equal("status is current after a due-date edit", expected.expectedStateAfterProjection, await state(kit, org, billId))
  check.equal("a due-date edit adds no journal entries", expected.expectedNewEntries, entryCount(kit, org) - before)
  check.equal("ledger unchanged", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, billId }
}

async function economicEdits(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "STATUS-01 economic edits", ["2026-07"])
  const billId = await createBill(kit, org, input.billDate, input.cents)
  await projectionJob(kit, org)
  const line = { description: "Framing", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId }
  const recoded = { ...line, cost_code_id: org.secondCostCodeId, project_id: org.secondProjectId, arc_books_gl_account_id: glId(kit, org, "5020") }
  const steps = [
    ["cost code", { actual_lines: [{ ...line, cost_code_id: org.secondCostCodeId }] }],
    ["job", { actual_lines: [{ ...line, cost_code_id: org.secondCostCodeId, project_id: org.secondProjectId }] }],
    ["expense account", { actual_lines: [recoded] }],
    ["bill date", { actual_lines: [recoded], bill_date: input.newBillDate }],
  ]
  for (const [label, next] of steps) {
    await editBill(kit, org, billId, next)
    check.equal(`${label}: not reported posted before the change is in the ledger`, expected.expectedStateBeforeProjection, await state(kit, org, billId))
    await projectionJob(kit, org)
    check.equal(`${label}: current once reprojected`, expected.expectedStateAfterProjection, await state(kit, org, billId))
  }
  check.equal("ledger carries only the final revision", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  const final = kit.rows(`select l.project_id, l.dimensions->>'cost_code_id' cost_code, l.debit_cents, e.entry_date::text entry_date from public.journal_lines l join public.journal_entries e on e.id=l.entry_id
    where l.org_id=${kit.q(org.orgId)} and e.status='posted' and e.source_type='vendor_bill' and l.debit_cents>0`)
  check.equal("the posted line carries the final job and cost code", [expected.expectedFinalLine], final.map((row) => ({ projectIsSecondJob: row.project_id === org.secondProjectId, costCodeIsSecond: row.cost_code === org.secondCostCodeId, cents: Number(row.debit_cents), entryDate: row.entry_date })))
  check.equal("each superseded revision is reversed, not deleted", expected.expectedReversedEntries, reversedCount(kit, org))
  return { orgId: org.orgId, billId }
}

async function closedPeriodReplacement(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "STATUS-01 closed replacement", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const billId = await createBill(kit, org, input.billDate, input.cents)
  await projectionJob(kit, org)
  const periodClose = app("books/period-close")
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(org.periods["2026-07"].periodId))
  const recoded = [{ description: "Framing", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: glId(kit, org, input.newAccount) }]
  let editRefused = false
  try { await editBill(kit, org, billId, { actual_lines: recoded }) } catch { editRefused = true }
  await projectionJob(kit, org)
  const recognitionFree = (net) => Object.fromEntries(Object.entries(net).filter(([code]) => !["2350", "4000"].includes(code)))
  check.equal("July's posted money is not retired while July is closed", expected.expectedJulyLedgerWhileClosed, recognitionFree(kit.postedNet(org.orgId)))
  const blockedState = await state(kit, org, billId)
  check.equal("the bill is not reported posted at its new coding", expected.expectedNotPostedWhileClosed, editRefused || blockedState !== "posted")
  const findings = openFindings(kit, org, billId)
  check.equal("a blocked replacement leaves a finding that leads to the source", expected.expectedFindingLeadsToSource, editRefused || (findings.length > 0 && findings.every((row) => Boolean(row.href))))
  await kit.as(org.owner, () => periodClose.reopenAccountingPeriod({ periodId: org.periods["2026-07"].periodId, reason: "Vendor bill coded to the wrong account" }))
  if (editRefused) await editBill(kit, org, billId, { actual_lines: recoded })
  await projectionJob(kit, org)
  check.equal("after the repair the bill is current", expected.expectedStateAfterRepair, await state(kit, org, billId))
  check.equal("the repair resolves the bill's findings", expected.expectedOpenFindingsAfterRepair, openFindings(kit, org, billId).length)
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(org.periods["2026-07"].periodId))
  check.equal("ledger carries the re-coded bill", expected.expectedNetDebitCentsByAccount, recognitionFree(kit.postedNet(org.orgId)))
  return { orgId: org.orgId, billId, editRefused, blockedState }
}

async function invoiceViewAndRevision(kit, expected, check) {
  const input = expected.inputs
  const org = await greenfieldOrg(kit, { name: "STATUS-01 invoice", periods: ["2026-07"] })
  const { createInvoice, recordInvoiceViewed, reviseInvoice, updateInvoice, issueInvoice } = app("invoices")
  const { createContact } = app("contacts")
  const client = await kit.as(org.owner, () => createContact({ input: { full_name: "Status Client", role_key: "client", email: "status@acceptance.example.test" } }))
  const invoiceInput = (cents) => ({ customer_id: client.id, title: "Consulting services", issue_date: input.issueDate, due_date: input.issueDate, sent_to_emails: ["status@acceptance.example.test"],
    lines: [{ description: "Services", quantity: 1, unit_cost: cents / 100, taxable: false, arc_books_gl_account_id: glId(kit, org, "4900") }] })
  const original = await kit.as(org.owner, () => createInvoice({ input: { ...invoiceInput(input.cents), invoice_number: `STI-${randomUUID().slice(0, 6)}`, issue: true } }))
  await kit.drainOutbox(org.orgId)
  await projectionJob(kit, org)
  const invoiceState = (id) => kit.as(org.owner, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "invoice", sourceId: id })).then((status) => status?.state)
  const before = entryCount(kit, org)
  const token = kit.rows(`select token from public.invoices where id=${kit.q(original.id)}`)[0].token
  await kit.service(() => recordInvoiceViewed({ invoiceId: original.id, orgId: org.orgId, token, userAgent: "acceptance", ipAddress: "127.0.0.1" }))
  await projectionJob(kit, org)
  check.equal("a client view leaves the status current", expected.expectedStateAfterView, await invoiceState(original.id))
  check.equal("a client view adds no entries", expected.expectedNewEntriesAfterView, entryCount(kit, org) - before)
  const replacement = await kit.as(org.owner, () => reviseInvoice({ invoiceId: original.id }))
  const draft = kit.rows(`select updated_at from public.invoices where id=${kit.q(replacement.id)}`)[0]
  await kit.as(org.owner, () => updateInvoice({ invoiceId: replacement.id, input: { ...invoiceInput(input.revisedCents), invoice_number: replacement.invoice_number }, expectedUpdatedAt: draft.updated_at }))
  await kit.as(org.owner, () => issueInvoice({ invoiceId: replacement.id }))
  await kit.drainOutbox(org.orgId)
  await projectionJob(kit, org)
  const originalState = await invoiceState(original.id)
  check.equal("the voided original reads reversed, never pending or posted", expected.expectedOriginalState, originalState)
  check.equal("the replacement is current", expected.expectedReplacementState, await invoiceState(replacement.id))
  check.equal("ledger carries only the replacement", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, originalId: original.id, replacementId: replacement.id, originalState }
}

async function partialRunScopedResolution(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "STATUS-01 scoped resolution", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const bills = { billA: await createBill(kit, org, input.billDate, input.cents), billB: await createBill(kit, org, input.billDate, input.cents) }
  await projectionJob(kit, org)
  const periodClose = app("books/period-close")
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents * 2 })
  await kit.as(org.owner, () => periodClose.closeAccountingPeriod(org.periods["2026-07"].periodId))
  const recoded = [{ description: "Framing", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: glId(kit, org, input.newAccount) }]
  for (const billId of Object.values(bills)) await editBill(kit, org, billId, { actual_lines: recoded })
  await projectionJob(kit, org)
  await kit.as(org.owner, () => periodClose.reopenAccountingPeriod({ periodId: org.periods["2026-07"].periodId, reason: "Re-coding two July framing bills" }))
  const snapshot = async () => Object.fromEntries(await Promise.all(Object.entries(bills).map(async ([name, id]) => [name, { state: await state(kit, org, id), openFindings: openFindings(kit, org, id).length }])))
  const { projectJournal } = app("books/projector")
  const { recordProjectionFailures } = app("books/reconciliation")
  const scoped = await kit.service(() => projectJournal(org.orgId, { sourceKeys: [`vendor_bill:${bills.billA}`] }))
  await kit.service(() => recordProjectionFailures([{ orgId: org.orgId, ...scoped }]))
  check.equal("a run scoped to bill A resolves only bill A", expected.expectedAfterScopedRun, await snapshot())
  await projectionJob(kit, org)
  check.equal("a full run then resolves bill B", expected.expectedAfterFullRun, await snapshot())
  return { orgId: org.orgId, ...bills }
}

module.exports = {
  id: "STATUS-01",
  subcases: {
    "bill-harmless-edit": harmlessEdit,
    "bill-economic-edits": economicEdits,
    "bill-closed-period-replacement-and-repair": closedPeriodReplacement,
    "invoice-view-and-revision": invoiceViewAndRevision,
    "partial-run-scoped-resolution": partialRunScopedResolution,
  },
}
