// MIG-01 — an existing builder moves its books to Arc (B03.3/B15.1). Its June 30
// trial balance comes over as one opening batch with every open invoice, bill,
// retainage, uncleared bank item, the loan and the equipment as its own line,
// reviewed by the owner and an accountant. Arc then runs in parallel with the
// builder's connected system: the opening equals the reference trial balance and
// every control, the projector adds nothing to it, the first collection and
// payment clear exactly the documents they name, and a comparison that does not
// agree with the connected system keeps cutover blocked.
const { randomUUID } = require("node:crypto")
const { app, monthBounds, project } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

async function existingBuilder(kit, name) {
  const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
  const org = { ...kit.organization({ name, chart: CONSTRUCTION_CHART_TEMPLATE, reviewerRole: "org_accountant" }), periods: {} }
  const { createAccountingPeriod } = app("books/period-close")
  for (const period of ["2026-06", "2026-07", "2026-08", "2026-09"]) {
    const bounds = monthBounds(period)
    org.periods[period] = await kit.as(org.owner, () => createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, fiscalYear: bounds.year, fiscalPeriod: bounds.month }))
  }
  await kit.as(org.owner, () => app("books/chart-management").createGlAccount({ code: "1001", name: "Payroll checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }))
  const q = kit.q, ids = { projectId: randomUUID(), contractId: randomUUID(), vendorId: randomUUID(), connectionId: randomUUID() }
  Object.assign(org, ids)
  // The builder's connected system, as Arc records it (no credentials).
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(ids.projectId)},${q(org.orgId)},'Hendricks residence','residential',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(ids.projectId)}) on conflict do nothing;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date) values(${q(ids.contractId)},${q(org.orgId)},${q(ids.projectId)},'Construction contract','active',90000000,'usd','fixed',10,'2026-01-15');
insert into public.companies(id,org_id,name) values(${q(ids.vendorId)},${q(org.orgId)},'Gulf Framing');
insert into public.accounting_connections(id,org_id,provider,label,external_account_id,status,connected_by) values(${q(ids.connectionId)},${q(org.orgId)},'qbo','QuickBooks',${q(`realm-${ids.connectionId}`)},'active',${q(org.owner.userId)});
commit;`)
  org.customerId = (await kit.as(org.owner, () => app("contacts").createContact({ input: { full_name: "Dana Hendricks", role_key: "client", email: "hendricks@acceptance.example.test" } }))).id
  const bank = (code, name) => kit.as(org.owner, () => app("books/bank-feeds").createManualBankAccount({ name, accountType: "depository", glAccountId: org.gl(code) }))
  org.gl = (code) => kit.rows(`select id from public.gl_accounts where org_id=${q(org.orgId)} and code=${q(code)}`)[0].id
  org.banks = { operating: (await bank("1000", "Operating")).bankAccountId, payroll: (await bank("1001", "Payroll")).bankAccountId }
  return org
}

function openingLines(org, input) {
  const t = input.trialBalance
  const ar = (number, cents, date) => ({ accountCode: "1100", subledgerType: "ar", description: `Open invoice ${number}`, debitCents: cents, creditCents: 0, projectId: org.projectId,
    details: { customer_id: org.customerId, document_number: number, document_date: date, due_date: date } })
  const ap = (number, cents, date) => ({ accountCode: "2000", subledgerType: "ap", description: `Open bill ${number}`, debitCents: 0, creditCents: cents, companyId: org.vendorId, projectId: org.projectId,
    details: { document_number: number, document_date: date, due_date: date } })
  const bankLine = (code, bankId, extra) => ({ accountCode: code, subledgerType: "bank", ...extra, details: { existing_entity_id: bankId, ...extra.details } })
  const lines = [
    bankLine("1000", org.banks.operating, { description: "Operating statement balance", debitCents: t.operatingStatement, creditCents: 0, details: {} }),
    bankLine("1000", org.banks.operating, { description: "Check 5001 to Gulf Framing", debitCents: 0, creditCents: t.outstandingCheck, details: { bank_opening_role: "outstanding_item", reference: "5001", document_date: "2026-06-28" } }),
    bankLine("1000", org.banks.operating, { description: "Deposit in transit", debitCents: t.depositInTransit, creditCents: 0, details: { bank_opening_role: "outstanding_item", reference: "DEP-0630", document_date: "2026-06-30" } }),
    bankLine("1001", org.banks.payroll, { description: "Payroll checking balance", debitCents: t.payrollBank, creditCents: 0, details: {} }),
    { accountCode: "1010", description: "Receipts not yet deposited", debitCents: t.undeposited, creditCents: 0 },
    ar("INV-1041", t.invoices[0], "2026-06-05"), ar("INV-1052", t.invoices[1], "2026-06-20"),
    { accountCode: "1110", subledgerType: "ar", description: "Retainage held on the Hendricks contract", debitCents: t.retainageReceivable, creditCents: 0, projectId: org.projectId,
      details: { customer_id: org.customerId, document_number: "RET-HEND", document_date: "2026-06-30", contract_id: org.contractId } },
    { accountCode: "1200", description: "Prepaid builder's risk", debitCents: t.prepaid, creditCents: 0 },
    { accountCode: "1500", subledgerType: "fixed_asset", description: "Crew truck", debitCents: t.truckCost, creditCents: 0,
      details: { asset_number: "TRK-07", document_date: "2025-07-01", placed_in_service_on: "2025-07-01", useful_life_months: 48, accumulated_depreciation_account_id: org.gl("1590"), depreciation_expense_account_id: org.gl("6080"), funding_account_id: org.gl("1000") } },
    { accountCode: "1590", subledgerType: "fixed_asset", description: "Crew truck depreciation to date", debitCents: 0, creditCents: t.truckDepreciation, details: { asset_number: "TRK-07" } },
    ap("V-311", t.bills[0], "2026-06-12"), ap("V-318", t.bills[1], "2026-06-26"),
    { accountCode: "2010", subledgerType: "ap", description: "Retainage withheld from Gulf Framing", debitCents: 0, creditCents: t.retainagePayable, companyId: org.vendorId, projectId: org.projectId,
      details: { document_number: "V-RET", document_date: "2026-06-30" } },
    { accountCode: "2230", description: "Payroll withholding due", debitCents: 0, creditCents: t.payrollWithholding },
    { accountCode: "2250", description: "Sales tax due", debitCents: 0, creditCents: t.salesTax },
    { accountCode: "2500", subledgerType: "loan", description: "Equipment loan", debitCents: 0, creditCents: t.loan,
      details: { document_number: "LN-88", document_date: "2025-07-01", cash_account_id: org.gl("1000"), interest_account_id: org.gl("6060"), annual_interest_bps: 750, payment_frequency: "monthly" } },
  ]
  const net = lines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0)
  lines.push({ accountCode: "3100", description: "Retained earnings at cutover", debitCents: net < 0 ? -net : 0, creditCents: net > 0 ? net : 0 })
  return lines
}

const trialBalance = async (kit, org, asOf) => {
  const report = await kit.service(() => app("books/statements").buildTrialBalance(org.orgId, asOf))
  return Object.fromEntries(report.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]).sort(([a], [b]) => a.localeCompare(b)))
}

async function builderImport(kit, expected, check) {
  const input = expected.inputs
  const org = await existingBuilder(kit, "MIG-01 builder import")
  const openings = app("books/opening-balances")
  const lines = openingLines(org, input)
  const batch = await kit.as(org.owner, () => openings.createOpeningBalanceBatch({ cutoverDate: "2026-06-30", sourceFilename: "quickbooks-trial-balance-2026-06-30.csv", sourceContent: JSON.stringify(lines), lines }))
  const postedBeforeReview = await refusal(() => kit.as(org.owner, () => openings.postOpeningBalanceBatch(batch.batchId)))
  await kit.as(org.owner, () => openings.approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "owner" }))
  await kit.as(org.reviewer, () => openings.approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "accountant" }))
  await kit.as(org.owner, () => openings.postOpeningBalanceBatch(batch.batchId))
  const atCutover = await trialBalance(kit, org, "2026-06-30")
  const linesAfterOpening = Number(kit.rows(`select count(*) n from public.journal_lines where org_id=${kit.q(org.orgId)}`)[0].n)
  await project(kit, org)
  const projectionAddsNothing = Number(kit.rows(`select count(*) n from public.journal_lines where org_id=${kit.q(org.orgId)}`)[0].n) === linesAfterOpening
  const controls = Object.fromEntries((await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2026-06-30")))
    .filter((row) => ["ar_control", "ap_control", "retainage_receivable_control", "retainage_payable_control", "fixed_asset_control", "accumulated_depreciation_control", "debt_control"].includes(row.code)).map((row) => [row.code, row.status]).sort(([a], [b]) => a.localeCompare(b)))

  // Each bank reconciles to its June 30 statement, the check and the deposit
  // still outstanding; the connected system has synced.
  const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  const statements = {}
  for (const [key, cents] of [["operating", input.trialBalance.operatingStatement], ["payroll", input.trialBalance.payrollBank]]) {
    const id = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: org.banks[key], statementStart: "2026-06-01", statementEnd: "2026-06-30", beginningBalanceCents: cents, endingBalanceCents: cents }))
    await kit.as(org.owner, () => closeBankReconciliation(id))
    const row = kit.rows(`select status, outstanding_balance_cents, book_balance_cents from public.bank_reconciliations where id=${kit.q(id)}`)[0]
    statements[key] = { status: row.status, outstanding: Number(row.outstanding_balance_cents), book: Number(row.book_balance_cents) }
  }
  kit.sql(`update public.accounting_connections set last_sync_at=now() where id=${kit.q(org.connectionId)}`)

  // Parallel with the connected system: a clean rebuild and reconciliation first.
  await kit.service(() => app("books/rebuild").runLedgerRebuildDrillForOrg(org.orgId))
  await kit.service(() => app("books/reconciliation").runOrgReconciliation(org.orgId))
  await kit.as(org.owner, () => app("books/module").promoteBooksToParallel({ attestation: "Opening reviewed by the owner and the outside CPA on 2026-07-01; parallel close approved." }))
  const mode = kit.rows(`select arc_ledger_mode, ledger_authority from public.books_settings where org_id=${kit.q(org.orgId)}`)[0]

  // The first collection and payment clear exactly the documents they name.
  const invoiceId = (number) => kit.rows(`select id from public.invoices where org_id=${kit.q(org.orgId)} and invoice_number=${kit.q(number)}`)[0].id
  const billId = (number) => kit.rows(`select id from public.vendor_bills where org_id=${kit.q(org.orgId)} and bill_number=${kit.q(number)}`)[0].id
  await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: "2026-07-08T12:00:00Z", method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoiceId("INV-1052"), amount_cents: input.trialBalance.invoices[1] }] }))
  await kit.as(org.owner, () => app("vendor-bills").updateVendorBillStatus({ billId: billId("V-318"), input: { status: "paid", payment_amount_cents: input.trialBalance.bills[1], payment_method: "check", payment_date: "2026-07-10",
    books_payment_account_id: org.gl("1000"), payment_idempotency_key: `mig-${org.orgId}` } }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const ar = await kit.as(org.owner, () => app("reports/ar-aging").getArAgingReport({ asOf: "2026-07-31" }))
  const ap = await kit.as(org.owner, () => app("reports/ap-aging").getApAgingReport({ asOf: "2026-07-31" }))
  const openByDocument = {
    receivables: Object.fromEntries(ar.rows.map((row) => [row.invoice_number, row.open_balance_cents]).sort(([a], [b]) => a.localeCompare(b))),
    payables: Object.fromEntries(ap.rows.map((row) => [row.bill_number ?? row.document_number, row.open_balance_cents ?? row.open_cents]).sort(([a], [b]) => a.localeCompare(b))),
  }

  // The connected system disagrees by 1.00 on undeposited funds: cutover stays blocked.
  const comparison = app("books/comparison")
  const external = Object.entries(atCutover).map(([code, cents], index) => ({ externalAccountId: `qbo-${index}`, externalAccountCode: code, externalAccountName: `QuickBooks ${code}`, arcAccountCode: code,
    debitCents: Math.max(code === "1010" ? cents - input.knownMismatchCents : cents, 0), creditCents: Math.max(-(code === "1010" ? cents - input.knownMismatchCents : cents), 0) }))
  const normal = kit.rows(`select code, normal_balance from public.gl_accounts where org_id=${kit.q(org.orgId)}`)
  const debitNormal = new Set(normal.filter((row) => row.normal_balance === "debit").map((row) => row.code))
  for (const row of external) if (!debitNormal.has(row.arcAccountCode)) { const cents = row.debitCents; row.debitCents = row.creditCents; row.creditCents = cents }
  await kit.as(org.owner, () => comparison.createBooksComparisonRun({ connectionId: org.connectionId, periodId: org.periods["2026-06"], asOf: "2026-06-30", externalRows: external }))
  const run = kit.rows(`select status, unexplained_variance_count n from public.books_comparison_runs where org_id=${kit.q(org.orgId)} order by created_at desc limit 1`)[0]
  const variances = kit.rows(`select a.code, i.difference_cents::bigint diff from public.books_comparison_items i join public.books_comparison_runs r on r.id=i.run_id left join public.gl_accounts a on a.id=i.account_id
    where r.org_id=${kit.q(org.orgId)} and i.difference_cents <> 0 order by a.code`).map((row) => ({ code: row.code, diff: Number(row.diff) }))
  const cutover = await kit.as(org.owner, () => app("books/cutover").prepareBooksCutover({ connectionId: org.connectionId, cutoverDate: "2026-09-30", targetPosture: "disconnected" }))

  check.equal("the opening equals the reference trial balance and its controls; parallel mode; the first collection and payment clear their own documents; a disagreement keeps cutover blocked", expected.expected, {
    postedBeforeReview: /approv/i.test(postedBeforeReview) ? "refused until reviewed" : postedBeforeReview,
    atCutover, projectionAddsNothing, controls, statements, mode,
    openByDocument, comparison: { unexplained: Number(run.n), variances },
    cutover: { status: cutover.status, blockedByComparisons: cutover.blockers.includes("three_approved_comparisons") },
  })
  return { orgId: org.orgId, cutoverBlockers: cutover.blockers }
}

// A migrated chart that already uses 1180 and 2180 for its own accounts: what the
// companies owe each other goes to Arc's own next free codes, never into the
// builder's accounts.
async function chartCollision(kit, expected, check) {
  const input = expected.inputs
  const { twoCompanies } = require("./entity-01.cjs").helpers
  const org = await twoCompanies(kit, "MIG-01 chart collision", { contractCents: 1000000 })
  const chart = app("books/chart-management")
  await kit.as(org.owner, () => chart.createGlAccount({ code: "1180", name: "Employee advances", accountType: "asset", subtype: "other_asset", normalBalance: "debit" }))
  await kit.as(org.owner, () => chart.createGlAccount({ code: "2180", name: "Accrued wages", accountType: "liability", subtype: "other_liability", normalBalance: "credit" }))
  const journal = (memo, lines) => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-10", memo, lines }))
  await journal("Advance to a foreman", [{ accountCode: "1180", debitCents: input.employeeAdvanceCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.employeeAdvanceCents }])
  await journal("Advance to the land company", [{ accountCode: "1005", debitCents: input.advanceCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: input.advanceCents }])
  const balances = Object.fromEntries(kit.rows(`select a.code, a.name, a.is_system, coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.gl_accounts a left join public.journal_lines l on l.account_id=a.id
    where a.org_id=${kit.q(org.orgId)} and a.code ~ '^[12]18[0-9]$' group by 1,2,3 order by 1`).map((row) => [row.code, { name: row.name, system: row.is_system, net: Number(row.n) }]))
  const rows = JSON.parse(kit.rows(`select public.books_intercompany_positions(${kit.q(org.orgId)}, '2026-07-31')::text p`)[0].p)
  const side = (entity) => rows.filter((row) => row.entityId === entity).reduce((sum, row) => ({ dueFrom: sum.dueFrom + Number(row.dueFromCents), dueTo: sum.dueTo + Number(row.dueToCents) }), { dueFrom: 0, dueTo: 0 })
  check.equal("the builder's 1180 and 2180 keep their own balances; intercompany uses Arc's 1181 and 2181", expected.expected, { accounts: balances, builder: side(org.builder), land: side(org.land) })
  return { orgId: org.orgId }
}

// A production builder brings its land and homes. An owned lot opens at its basis
// and the opening becomes its acquisition; a spec home under construction and a
// completed one open with the job cost behind them, so the land, completed-home
// and job-cost controls tie from cutover. Plain lines on those accounts, a lot
// without its lot and a completed home without its date are refused with every
// fix named; a lot that already has basis is refused at posting.
async function landAndHomes(kit, expected, check) {
  const input = expected.inputs
  const org = await existingBuilder(kit, "MIG-01 production builder")
  const q = kit.q, ids = { communityId: randomUUID(), landLot: randomUUID(), specLot: randomUUID(), completedLot: randomUUID(), spec: randomUUID(), completed: randomUUID(), costCodeId: randomUUID() }
  kit.sql(`begin;
insert into public.communities(id,org_id,name) values(${q(ids.communityId)},${q(org.orgId)},'Willow Bend');
insert into public.cost_codes(id,org_id,code,name) values(${q(ids.costCodeId)},${q(org.orgId)},'01-000','Construction to date');
${[["spec", "Willow Bend lot 7"], ["completed", "Willow Bend lot 8"]].map(([key, name]) => `insert into public.projects(id,org_id,name,property_type,created_by) values(${q(ids[key])},${q(org.orgId)},${q(name)},'production',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(ids[key])}) on conflict do nothing;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(randomUUID())},${q(org.orgId)},${q(ids[key])},'Spec home, for sale','active',0,'usd','purchase_agreement',0,'2026-01-15');`).join("\n")}
insert into public.lots(id,org_id,community_id,lot_number,status) values(${q(ids.landLot)},${q(org.orgId)},${q(ids.communityId)},'6','controlled'),
  (${q(ids.specLot)},${q(org.orgId)},${q(ids.communityId)},'7','assigned'),(${q(ids.completedLot)},${q(org.orgId)},${q(ids.communityId)},'8','assigned');
commit;`)
  const inventory = app("books/inventory")
  for (const projectId of [ids.spec, ids.completed])
    await kit.as(org.owner, () => inventory.enableProjectInventory({ projectId, effectiveOn: "2026-01-15", evidenceUrl: "https://evidence.acceptance.example.test/mig-01/spec-policy" }))
  const t = input.openings
  const land = { accountCode: "1120", subledgerType: "land", description: "Lot 6 held for a future start", debitCents: t.landCents, creditCents: 0, details: { lot_id: ids.landLot, document_date: "2025-11-14" } }
  const spec = { accountCode: "1160", subledgerType: "home_inventory", description: "Lot 7 spec home, framing complete", debitCents: t.specCents, creditCents: 0, projectId: ids.spec, details: { cost_code_id: ids.costCodeId } }
  const done = { accountCode: "1170", subledgerType: "home_inventory", description: "Lot 8 spec home, completed", debitCents: t.completedCents, creditCents: 0, projectId: ids.completed, details: { completed_on: "2026-05-20" } }
  const equity = { accountCode: "3100", description: "Retained earnings at cutover", debitCents: 0, creditCents: t.landCents + t.specCents + t.completedCents }
  const openings = app("books/opening-balances")
  const create = (lines) => kit.as(org.owner, () => openings.createOpeningBalanceBatch({ cutoverDate: "2026-06-30", sourceFilename: "inventory-2026-06-30.json", sourceContent: JSON.stringify(lines), lines }))
  const mistakes = await refusal(() => create([{ ...land, subledgerType: undefined }, { ...spec, subledgerType: "other" }, { ...done, details: {} }, equity]))
  const batch = await create([land, spec, done, equity])
  const post = async (batchId) => {
    await kit.as(org.owner, () => openings.approveOpeningBalanceBatch({ batchId, approvalRole: "owner" }))
    await kit.as(org.reviewer, () => openings.approveOpeningBalanceBatch({ batchId, approvalRole: "accountant" }))
    return kit.as(org.owner, () => openings.postOpeningBalanceBatch(batchId))
  }
  await post(batch.batchId)
  const again = await create([{ ...land, debitCents: 100 }, { ...equity, creditCents: 100 }])
  const landTwice = await refusal(() => post(again.batchId))
  const lot = kit.rows(`select status, cost_basis_cents::bigint basis, acquired_date::text acquired from public.lots where id=${q(ids.landLot)}`)[0]
  const controls = async (asOf) => Object.fromEntries((await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, asOf)))
    .filter((row) => ["job_cost_control", "land_inventory_control", "completed_homes_control", "trial_balance"].includes(row.code)).map((row) => [row.code, row.status]).sort(([a], [b]) => a.localeCompare(b)))
  const atCutover = await controls("2026-06-30")
  // July: the spec home keeps building on its opening cost.
  const vendorBills = app("vendor-bills")
  const bill = await kit.as(org.owner, () => vendorBills.createProjectVendorBill({ projectId: ids.spec, input: { company_id: org.vendorId, bill_number: "WB-701", bill_date: "2026-07-09", due_date: "2026-08-08", total_cents: input.julyBillCents,
    actual_lines: [{ cost_code_id: ids.costCodeId, description: "Drywall", amount_cents: input.julyBillCents, project_id: ids.spec }] } }))
  await kit.as(org.owner, () => vendorBills.approveVendorBillsAtomic([{ id: bill.id }]))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const jobCost = (projectId) => Number(kit.rows(`select coalesce(sum(cost_cents),0)::bigint n from public.job_cost_entries where org_id=${q(org.orgId)} and project_id=${q(projectId)} and status='posted'`)[0].n)
  check.equal("land and homes open with their lot basis and job cost; every inventory control ties at cutover and after the first month; mistakes are named and a lot cannot open twice", expected.expected, {
    mistakesRefused: mistakes.split("\n").filter((line) => line.startsWith("•")).length,
    trialBalance: await trialBalance(kit, org, "2026-06-30"),
    lot: { status: lot.status, basis: Number(lot.basis), acquired: lot.acquired },
    homes: { specJobCost: jobCost(ids.spec), completedJobCost: jobCost(ids.completed),
      completedOn: kit.rows(`select books_inventory_completed_on::text d from public.project_financial_settings where project_id=${q(ids.completed)}`)[0].d },
    landTwiceRefused: /already has recorded land basis/.test(landTwice), atCutover, afterJuly: await controls("2026-07-31"),
  })
  // Reversing the opening puts the lot back under control and takes the homes'
  // opening cost and completion out, while July's bill stays on its home.
  await kit.as(org.reviewer, () => openings.reverseOpeningBalanceBatch({ batchId: batch.batchId, reversalDate: "2026-07-31", reason: "Inventory opening re-cut after the count" }))
  const reversedLot = kit.rows(`select status, cost_basis_cents, books_acquisition_entry_id from public.lots where id=${q(ids.landLot)}`)[0]
  check.equal("reversing the opening returns the lot, the homes' opening cost and the completion, and the controls still tie", expected.expectedAfterReversal, {
    lot: { status: reversedLot.status, basis: reversedLot.cost_basis_cents, acquisition: reversedLot.books_acquisition_entry_id },
    specJobCost: jobCost(ids.spec), completedJobCost: jobCost(ids.completed),
    completedOn: kit.rows(`select books_inventory_completed_on d from public.project_financial_settings where project_id=${q(ids.completed)}`)[0].d,
    controls: await controls("2026-07-31"),
  })
  return { orgId: org.orgId }
}

module.exports = {
  id: "MIG-01",
  subcases: { "builder-import": builderImport, "chart-collision": chartCollision, "land-and-homes": landAndHomes },
}
