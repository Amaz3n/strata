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

async function expenseFamily(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "STATUS-01 expense", ["2026-07"])
  const { createProjectExpense, approveProjectExpense, replaceProjectExpenseLines, rejectProjectExpense } = app("cost-plus")
  const created = await kit.as(org.owner, () => createProjectExpense({ projectId: org.projectId, costCodeId: org.costCodeId, expenseDate: input.expenseDate, description: "Lumber yard run",
    vendorNameText: "Lumber yard", amountCents: input.cents, paymentMethod: input.paymentMethod, booksPaymentAccountId: glId(kit, org, "1000"), isBillable: false }))
  const expenseId = created.id
  await kit.as(org.owner, () => approveProjectExpense(expenseId))
  await kit.drainOutbox(org.orgId)
  await projectionJob(kit, org)
  const expenseState = () => kit.as(org.owner, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "expense", sourceId: expenseId })).then((status) => status?.state)
  check.equal("approved expense is current", expected.expectedStateAfterApproval, await expenseState())
  check.equal("approved expense posts once", expected.expectedLedgerAfterApproval, kit.postedNet(org.orgId))
  await kit.as(org.owner, () => replaceProjectExpenseLines({ expenseId, lines: [{ project_id: org.projectId, cost_code_id: org.secondCostCodeId, description: "Lumber yard run", amount_cents: input.cents }] }))
  check.equal("a re-code is pending until reprojected", expected.expectedStateBeforeRecodeProjection, await expenseState())
  await projectionJob(kit, org)
  check.equal("the re-code is current once reprojected", expected.expectedStateAfterRecode, await expenseState())
  await kit.as(org.owner, () => rejectProjectExpense(expenseId, { rejectionReason: "Personal purchase, not job cost" }))
  await projectionJob(kit, org)
  check.equal("a rejected expense reads reversed", expected.expectedStateAfterRejection, await expenseState())
  check.equal("a rejected expense leaves no money", expected.expectedNetDebitCentsByAccount, kit.postedNet(org.orgId))
  return { orgId: org.orgId, expenseId }
}

// The scheduled run: incremental, never the nightly full pass.
async function incrementalJob(kit, org) {
  const { projectJournal } = app("books/projector")
  const { recordProjectionFailures } = app("books/reconciliation")
  const result = await kit.service(() => projectJournal(org.orgId))
  await kit.service(() => recordProjectionFailures([{ orgId: org.orgId, ...result }]))
}

async function dependencyInvalidation(kit, expected, check) {
  const input = expected.inputs
  const want = expected.expected
  const org = await contractJob(kit, { name: "STATUS-01 dependencies", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"],
    accounts: [{ code: "1005", name: "Payroll checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }, { code: "6810", name: "Estimating software", accountType: "expense", subtype: "software", normalBalance: "debit" }] })
  const billState = (id) => state(kit, org, id)

  // A job-cost line re-coded after the bill posted (the app writes cost lines after the bill).
  const recodeBill = await createBill(kit, org, input.billDate, input.cents)
  await incrementalJob(kit, org)
  const newCode = randomUUID()
  kit.sql(`insert into public.cost_codes(id,org_id,code,name) values(${kit.q(newCode)},${kit.q(org.orgId)},'06-300','Trim carpentry');
update public.job_cost_entries set cost_code_id=${kit.q(newCode)} where org_id=${kit.q(org.orgId)} and source_type='vendor_bill_line' and source_id in (select id::text from public.bill_lines where bill_id=${kit.q(recodeBill)});`)
  const recodeBefore = await billState(recodeBill)
  await incrementalJob(kit, org)
  const recodeLine = kit.rows(`select l.dimensions->>'cost_code_id' code from public.journal_lines l join public.journal_entries e on e.id=l.entry_id where e.org_id=${kit.q(org.orgId)} and e.source_type='vendor_bill' and e.source_id=${kit.q(recodeBill)} and e.status='posted' and l.debit_cents>0`)
  check.equal("job-cost re-code: pending, then current with the new cost code", want["job-cost-recode"], { before: recodeBefore, after: await billState(recodeBill), postedCostCodeIsNew: recodeLine.length === 1 && recodeLine[0].code === newCode })

  // The project's billing model and a new contract decide how its documents post.
  kit.sql(`update public.project_financial_settings set billing_model='cost_plus_percent' where project_id=${kit.q(org.projectId)};`)
  const settingsBefore = await billState(recodeBill)
  await incrementalJob(kit, org)
  check.equal("billing model: pending, then current", want["billing-model"], { before: settingsBefore, after: await billState(recodeBill) })
  kit.sql(`insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date) values(gen_random_uuid(),${kit.q(org.orgId)},${kit.q(org.projectId)},'Change order contract','draft',100000,'usd','fixed',0,'2026-07-01');`)
  const contractBefore = await billState(recodeBill)
  await incrementalJob(kit, org)
  check.equal("new contract: pending, then current", want["new-contract"], { before: contractBefore, after: await billState(recodeBill) })

  // A payment that names an unmapped funding source fails until the source is mapped.
  const paidBill = await createBill(kit, org, input.billDate, input.cents)
  await kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId: paidBill, input: { status: "paid", payment_amount_cents: input.cents, payment_method: "ach",
    payment_date: "2026-07-15", books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `dep-fund-${org.orgId}` } }))
  const fundingId = randomUUID()
  kit.sql(`insert into public.org_funding_sources(id,org_id,provider,provider_customer_id,provider_payment_method_id,mandate_status,verification_status,status,is_default,created_by)
  values(${kit.q(fundingId)},${kit.q(org.orgId)},'stripe',${kit.q(`cus_${fundingId}`)},${kit.q(`pm_${fundingId}`)},'accepted','verified','active',false,${kit.q(org.owner.userId)});
update public.payments set metadata=(metadata - 'books_payment_account_id') || jsonb_build_object('funding_source_id',${kit.q(fundingId)}) where bill_id=${kit.q(paidBill)};`)
  const paymentId = kit.rows(`select id from public.payments where bill_id=${kit.q(paidBill)}`)[0].id
  await incrementalJob(kit, org)
  const failed = kit.rows(`select count(*) n from public.accounting_reconciliation_items where org_id=${kit.q(org.orgId)} and entity_id::text=${kit.q(paymentId)} and status<>'resolved'`)[0].n > 0
  await kit.as(org.owner, () => app("books/funding").saveBooksFundingAccount({ fundingSourceId: fundingId, accountId: glId(kit, org, "1005") }))
  await incrementalJob(kit, org)
  const paidFrom = kit.rows(`select a.code from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${kit.q(org.orgId)} and e.source_id=${kit.q(paymentId)} and e.status='posted' and l.credit_cents>0`)[0]?.code
  check.equal("funding remap: fails while unmapped, posts to the mapped account on the next run", want["funding-remap"], { failedBeforeMapping: failed, postedToMappedAccount: paidFrom })

  // A chart account named on a bill line is deactivated.
  const softwareBill = await createBill(kit, org, input.billDate, input.cents)
  await kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId: softwareBill, input: { status: "approved", actual_lines: [{ description: "Estimating software", amount_cents: input.cents, cost_code_id: org.costCodeId, project_id: org.projectId, arc_books_gl_account_id: glId(kit, org, "6810") }] } }))
  await incrementalJob(kit, org)
  const postedBefore = kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)} and source_id=${kit.q(softwareBill)} and status='posted'`)[0].n
  await kit.as(org.owner, () => app("books/chart-management").setGlAccountActive(glId(kit, org, "6810"), false))
  const deactivatedBefore = await billState(softwareBill)
  await incrementalJob(kit, org)
  const deactivatedAfter = await billState(softwareBill)
  const postedAfter = kit.rows(`select count(*) n from public.journal_entries where org_id=${kit.q(org.orgId)} and source_id=${kit.q(softwareBill)} and status='posted'`)[0].n
  check.equal("account deactivated: pending, then re-evaluated with its posted history kept", want["account-deactivated"],
    { before: deactivatedBefore, afterIsNotStalePosted: deactivatedAfter !== "pending", historyPreserved: postedBefore === 1 && postedAfter === 1 })

  // A reopened period retries what its close blocked, without waiting for the nightly run.
  const closed = await contractJob(kit, { name: "STATUS-01 reopen retry", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const blockedBill = await createBill(kit, closed, input.billDate, input.cents)
  await incrementalJob(kit, closed)
  await prepareAndReview(kit, closed, "2026-07", { contractCents: input.contractCents, eacCents: input.contractCents })
  const periodClose = app("books/period-close")
  await kit.as(closed.owner, () => periodClose.closeAccountingPeriod(closed.periods["2026-07"].periodId))
  await editBill(kit, closed, blockedBill, { actual_lines: [{ description: "Framing", amount_cents: input.cents, cost_code_id: closed.costCodeId, project_id: closed.projectId, arc_books_gl_account_id: glId(kit, closed, "5020") }] })
  await incrementalJob(kit, closed)
  const blocked = await state(kit, closed, blockedBill)
  await kit.as(closed.owner, () => periodClose.reopenAccountingPeriod({ periodId: closed.periods["2026-07"].periodId, reason: "Vendor bill coded to the wrong account" }))
  await incrementalJob(kit, closed)
  check.equal("reopen: the blocked bill posts on the next incremental run", want["reopen-retries-blocked"], { blocked, afterReopenIncremental: await state(kit, closed, blockedBill) })
  return { orgId: org.orgId, reopenOrgId: closed.orgId, deactivatedAfter }
}

// Who may read a document's posting status: the project's own readers for
// project documents, Books readers for company documents, nobody else; and a
// company without the Arc ledger gets no status rather than a false one.
async function accessAndEmpty(kit, expected, check) {
  const input = expected.inputs
  const want = expected.expected
  const org = await jobOrg(kit, "STATUS-01 access", ["2026-07"])
  const { q } = kit
  const pm = { userId: randomUUID(), orgId: org.orgId, productTier: "residential", role: "org_user" }
  kit.sql(`begin;
insert into auth.users(id,instance_id,aud,role,email,created_at,updated_at) values(${q(pm.userId)},'00000000-0000-0000-0000-000000000000','authenticated','authenticated',${q(`${pm.userId}@acceptance.example.test`)},now(),now());
insert into public.app_users(id,email,full_name) values(${q(pm.userId)},${q(`${pm.userId}@acceptance.example.test`)},'Project manager on the first job');
insert into public.memberships(org_id,user_id,role_id,status) select ${q(org.orgId)},${q(pm.userId)},id,'active' from public.roles where key='org_user';
insert into public.project_members(org_id,project_id,user_id,role_id) select ${q(org.orgId)},${q(org.projectId)},${q(pm.userId)},id from public.roles where key='pm';
commit;`)
  const ownBill = await createBill(kit, org, input.billDate, input.cents)
  const otherBill = await createBill(kit, { ...org, projectId: org.secondProjectId }, input.billDate, input.cents)
  const companyBill = randomUUID()
  kit.sql(`insert into public.vendor_bills(id,org_id,company_id,bill_number,bill_date,due_date,total_cents,status) values(${q(companyBill)},${q(org.orgId)},${q(org.vendorId)},'ST-COMPANY',${q(input.billDate)},${q(input.billDate)},${input.cents},'approved')`)
  await projectionJob(kit, org)
  const status = (actor, sourceId) => kit.as(actor, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "vendor_bill", sourceId }))
  const outcome = async (actor, sourceId) => { try { return (await status(actor, sourceId))?.state ?? "none" } catch { return "refused" } }
  check.equal("project documents follow the project's readers", want["project-scope"], {
    pmOwnProject: await outcome(pm, ownBill), pmOtherProject: await outcome(pm, otherBill), booksReviewerOnProjectBill: await outcome(org.reviewer, ownBill) })
  check.equal("company documents need Books read access", want["company-document"], {
    pm: await outcome(pm, companyBill), booksReviewer: await outcome(org.reviewer, companyBill), owner: await outcome(org.owner, companyBill) })
  kit.sql(`update public.books_settings set ledger_authority='external', arc_ledger_mode='disabled', external_sync_posture='normal' where org_id=${q(org.orgId)}`)
  check.equal("no Arc ledger: no status, not a false pending", want["ledger-disabled"], { owner: await outcome(org.owner, ownBill) })
  return { orgId: org.orgId }
}

// Deleting a posted document would leave its money in the ledger until the
// nightly pass; it is refused until the document is returned and reversed.
async function postedSourceDeletion(kit, expected, check) {
  const input = expected.inputs
  const want = expected.expected
  const org = await jobOrg(kit, "STATUS-01 posted deletion", ["2026-07"])
  const billId = await createBill(kit, org, input.billDate, input.cents)
  await incrementalJob(kit, org)
  const { deleteVendorBill } = app("vendor-bills")
  const attempt = async () => { try { await kit.as(org.owner, () => deleteVendorBill({ billId })); return "deleted" } catch (error) { return /posted to the ledger/.test(error.message) ? "refused: posted" : `refused: ${error.message}` } }
  const exists = () => Number(kit.rows(`select count(*) n from public.vendor_bills where org_id=${kit.q(org.orgId)} and id=${kit.q(billId)}`)[0].n) === 1
  const liveJobCost = () => Number(kit.rows(`select coalesce(sum(j.cost_cents),0) n from public.job_cost_entries j join public.bill_lines l on l.id::text=j.source_id
    where j.org_id=${kit.q(org.orgId)} and j.source_type='vendor_bill_line' and l.bill_id=${kit.q(billId)} and j.status='posted'`)[0].n)
  const entries = () => kit.rows(`select status from public.journal_entries where org_id=${kit.q(org.orgId)} and source_id=${kit.q(billId)} order by created_at`).map((row) => row.status)
  const posted = { state: await state(kit, org, billId), delete: await attempt(), stillExists: exists(), entries: entries(), jobCostCents: liveJobCost() }
  // Returned to pending: the next 10-minute run reverses it, and then it deletes.
  await kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId, input: { status: "pending" } }))
  const beforeRun = { delete: await attempt(), stillExists: exists() }
  await incrementalJob(kit, org)
  const afterRun = { entries: entries(), delete: await attempt(), stillExists: exists() }
  await projectionJob(kit, org)
  const net = kit.postedNet(org.orgId, `e.source_id=${kit.q(billId)} or e.reversal_of_entry_id in (select id from public.journal_entries where source_id=${kit.q(billId)})`)
  check.equal("a posted bill cannot be deleted", want.posted, posted)
  check.equal("returned to pending: refused until its journal is reversed", want["before-reversal"], beforeRun)
  check.equal("reversed: deletes, and the ledger keeps nothing for it", want["after-reversal"], { ...afterRun, ledgerNet: net, openFindings: openFindings(kit, org, billId).length })
  return { orgId: org.orgId }
}

// A contract dated in the future comes into force with nobody editing anything.
// The first ordinary run after that day re-reads the job, but an invoice dated
// before the contract keeps the revenue policy it posted under (B11.1); the
// changed settings are flagged on the revenue policy register for review.
async function contractTakesEffect(kit, expected, check) {
  const input = expected.inputs
  const org = await jobOrg(kit, "STATUS-01 contract takes effect", ["2026-07"])
  const { q } = kit
  kit.sql(`select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object('project_id',${q(org.projectId)},'invoice_number','STE-1',
  'title','Progress billing','issue_date',${q(input.issueDate)},'due_date',${q(input.issueDate)},'client_visible',true,'approval_status','approved',
  'product_posture','residential','subtotal_cents',${input.cents},'tax_cents',0,'total_cents',${input.cents},'balance_due_cents',${input.cents},'token',${q(randomUUID())}),
  jsonb_build_array(jsonb_build_object('description','Work completed','quantity',1,'unit_price_cents',${input.cents},'amount_cents',${input.cents})));`)
  const invoiceId = kit.rows(`select id from public.invoices where org_id = ${q(org.orgId)} and invoice_number = 'STE-1'`)[0].id
  await incrementalJob(kit, org)
  const credited = () => kit.rows(`select a.code from public.journal_lines l join public.journal_entries e on e.id = l.entry_id join public.gl_accounts a on a.id = l.account_id
    where e.org_id = ${q(org.orgId)} and e.source_id = ${q(invoiceId)} and e.status = 'posted' and l.credit_cents > 0 order by a.code`).map((row) => row.code)
  const status = () => kit.as(org.owner, () => app("books/posting-status").getBooksPostingStatus({ sourceType: "invoice", sourceId: invoiceId })).then((result) => result?.state)
  const noContract = credited()
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  kit.sql(`insert into public.contracts(org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(org.orgId)},${q(org.projectId)},'Purchase agreement','active',${input.contractCents},'usd','purchase_agreement',0,${q(tomorrow)})`)
  await incrementalJob(kit, org)
  const beforeEffective = credited()
  // The day passes: the agreement is now in effect and nothing was edited. The last
  // run read yesterday, and the invoice last changed before that.
  kit.sql(`begin; set local session_replication_role = replica;
update public.contracts set effective_date = current_date where org_id = ${q(org.orgId)};
update public.invoices set updated_at = now() - interval '2 days' where id = ${q(invoiceId)};
update public.books_projection_progress set read_started_at = now() - interval '1 day' where org_id = ${q(org.orgId)};
commit;`, "supabase_admin")
  await incrementalJob(kit, org)
  const listed = (await kit.as(org.owner, () => app("books/revenue-policies").getRevenuePolicyRegister())).rows.find((row) => row.projectId === org.projectId)
  check.equal("a contract taking effect later leaves an earlier invoice under its posted policy and flags the change", expected.expected, {
    noContract, beforeEffective, afterEffective: credited(), status: await status(),
    register: { method: listed.inForce.method, source: listed.inForce.source, drift: listed.drift, settingsSay: listed.settingsSay.method },
  })
  return { orgId: org.orgId, invoiceId }
}

module.exports = {
  id: "STATUS-01",
  subcases: {
    "bill-harmless-edit": harmlessEdit,
    "bill-economic-edits": economicEdits,
    "bill-closed-period-replacement-and-repair": closedPeriodReplacement,
    "invoice-view-and-revision": invoiceViewAndRevision,
    "partial-run-scoped-resolution": partialRunScopedResolution,
    "expense-family": expenseFamily,
    "dependency-invalidation": dependencyInvalidation,
    "access-and-empty": accessAndEmpty,
    "posted-source-deletion": postedSourceDeletion,
    "contract-takes-effect": contractTakesEffect,
  },
}

module.exports.helpers = { jobOrg, createBill, editBill, incrementalJob, projectionJob, glId }
