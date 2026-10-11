// HOME-01 — a builder's own homes (B11.3): land and shared development reach
// lots through a reviewed allocation, a sold home leaves inventory by the cost it
// came from, only its own deposit is applied, costs after the sale follow an
// explicit policy, warranty work consumes the reserve against the cost it came
// from, the land / completed-home / warranty controls tie to the ledger, and a
// reversed closing puts the books back exactly.
const { randomUUID } = require("node:crypto")
const { app, greenfieldOrg, project } = require("./shared.cjs")

const EVIDENCE = "https://evidence.acceptance.example.test/home-01"
const sorted = (value) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

// Net debit by account code on one home (or one lot for land), as of a date.
function balances(kit, org, { projectId = null, lotId = null, codes, asOf = "2099-12-31" }) {
  const scope = projectId ? `l.project_id=${kit.q(projectId)}` : `l.dimensions->>'lot_id'=${kit.q(lotId)}`
  const rows = kit.rows(`select a.code, coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${kit.q(org.orgId)} and ${scope} and e.status in ('posted','reversed') and e.entry_date<=${kit.q(asOf)} and a.code in (${codes.map(kit.q).join(",")}) group by 1`)
  return Object.fromEntries(codes.map((code) => [code, Number(rows.find((row) => row.code === code)?.n ?? 0)]))
}

// Cost of sales on one home by the component each relief line names.
function reliefByComponent(kit, org, projectId) {
  const rows = kit.rows(`select coalesce(l.dimensions->>'cost_component','unlabeled') component, sum(l.debit_cents-l.credit_cents)::bigint n from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${kit.q(org.orgId)} and l.project_id=${kit.q(projectId)} and a.code='5000' and e.source_type='inventory_sale_relief' and e.status in ('posted','reversed') group by 1`)
  return sorted(Object.fromEntries(rows.filter((row) => Number(row.n) !== 0).map((row) => [row.component, Number(row.n)])))
}

// A builder with one community, a development job holding shared site cost,
// and homes each on its own lot under a purchase agreement with a buyer.
async function builder(kit, name, homes, password) {
  const { q } = kit
  const ids = { communityId: randomUUID(), vendorId: randomUUID(), costCodeId: randomUUID(), developmentId: randomUUID(), developmentLotIds: [randomUUID(), randomUUID(), randomUUID()] }
  const org = await greenfieldOrg(kit, { name, password, periods: ["2026-06", "2026-07", "2026-08"], setup: (org) => {
    Object.assign(org, ids, { homes: homes.map((home, index) => ({ ...home, projectId: randomUUID(), lotId: randomUUID(), buyerId: randomUUID(), contractId: randomUUID(), lotNumber: String(index + 1) })) })
    kit.sql(`begin;
insert into public.communities(id,org_id,name) values(${q(org.communityId)},${q(org.orgId)},'Cedar Ridge');
insert into public.companies(id,org_id,name) values(${q(org.vendorId)},${q(org.orgId)},'Cedar Ridge framing');
insert into public.cost_codes(id,org_id,code,name) values(${q(org.costCodeId)},${q(org.orgId)},'06-100','Rough carpentry');
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(org.developmentId)},${q(org.orgId)},'Cedar Ridge site development','production',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(org.developmentId)}) on conflict do nothing;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date)
  values(${q(randomUUID())},${q(org.orgId)},${q(org.developmentId)},'Community land plan','active',0,'usd','purchase_agreement',0,'2026-06-01');
${org.developmentLotIds.map((id, index) => `insert into public.lots(id,org_id,community_id,lot_number,status) values(${q(id)},${q(org.orgId)},${q(org.communityId)},${q(`D${index + 1}`)},'controlled');`).join("\n")}
${org.homes.map((home) => `insert into public.contacts(id,org_id,full_name,email) values(${q(home.buyerId)},${q(org.orgId)},${q(`${home.name} buyer`)},${q(`buyer-${home.lotNumber}@acceptance.example.test`)});
insert into public.projects(id,org_id,name,property_type,created_by,client_id) values(${q(home.projectId)},${q(org.orgId)},${q(home.name)},'production',${q(org.owner.userId)},${q(home.buyerId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(home.projectId)}) on conflict do nothing;
insert into public.lots(id,org_id,community_id,lot_number,status) values(${q(home.lotId)},${q(org.orgId)},${q(org.communityId)},${q(home.lotNumber)},'controlled');
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date,signed_at,buyer_contact_id,snapshot)
  values(${q(home.contractId)},${q(org.orgId)},${q(home.projectId)},'Purchase agreement','active',${home.priceCents},'usd','purchase_agreement',0,'2026-06-01','2026-06-01T12:00:00Z',${q(home.buyerId)},
  jsonb_build_object('purchase_agreement',jsonb_build_object('version',1,'pricing',jsonb_build_object('basePriceCents',${home.priceCents},'lotPremiumCents',0,'structuralOptions','[]'::jsonb,'designSelections','[]'::jsonb,'incentives','[]'::jsonb,'structuralOptionsCents',0,'designSelectionsCents',0,'incentivesCents',0,'totalCents',${home.priceCents}))));`).join("\n")}
commit;`)
  } })
  return org
}

async function bill(kit, org, projectId, date, cents, description = "Framing") {
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId, input: {
    company_id: org.vendorId, bill_number: `H-${randomUUID().slice(0, 8)}`, bill_date: date, due_date: date, total_cents: cents,
    actual_lines: [{ cost_code_id: org.costCodeId, description, amount_cents: cents, project_id: projectId }],
  } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return created.id
}

// Land bought for a home's lot and moved into the house when it starts.
async function landAndStart(kit, org, home, { date, startDate, cents }) {
  const inventory = app("books/inventory")
  await kit.as(org.owner, () => inventory.enableProjectInventory({ projectId: home.projectId, effectiveOn: "2026-06-01", evidenceUrl: `${EVIDENCE}/ownership` }))
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date, allocations: [{ lotId: home.lotId, amountCents: cents }], cashAccountId: glId(kit, org, "1000"), cashCents: cents, debtInstrumentId: null, debtCents: 0, reference: `Lot ${home.lotNumber} settlement`, evidenceUrl: `${EVIDENCE}/land-${home.lotNumber}` }))
  kit.sql(`update public.lots set project_id=${kit.q(home.projectId)} where id=${kit.q(home.lotId)}`)
  await kit.service(() => inventory.transferLandAtStartForService(org.orgId, home.lotId, startDate, org.owner.userId))
  await project(kit, org)
}

// Actual interest paid, the eligible part capitalized into the home.
async function capitalizedInterest(kit, org, home, { date, paidCents, eligibleCents }) {
  const entry = await kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: date, memo: "Construction loan interest", lines: [
    { accountCode: "6060", debitCents: paidCents, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: paidCents }] }))
  const line = kit.rows(`select l.id from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.entry_id=${kit.q(entry.id)} and a.code='6060'`)[0].id
  await kit.as(org.owner, () => app("books/inventory").capitalizeInventoryInterest({ projectId: home.projectId, sourceLineId: line, date, amountCents: eligibleCents, reference: `Interest ${home.lotNumber}`, evidenceUrl: `${EVIDENCE}/interest` }))
}

// An earnest deposit requested and received on a home; returns the payment.
async function deposit(kit, org, home, { date, cents }) {
  const invoice = await kit.as(org.owner, () => app("invoices").createInvoice({ input: { project_id: home.projectId, invoice_number: `DEP-${home.lotNumber}-${randomUUID().slice(0, 4)}`, customer_id: home.buyerId,
    title: "Earnest deposit", issue: true, issue_date: date, due_date: date, tax_rate: 0, sent_to_emails: [`buyer-${home.lotNumber}@acceptance.example.test`],
    lines: [{ description: "Earnest deposit", quantity: 1, unit_cost: cents / 100, taxable: false }], metadata: { invoice_kind: "earnest_deposit" } } }))
  await kit.as(org.owner, () => app("payments").recordMultiInvoicePayment({ received_at: `${date}T12:00:00Z`, method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: cents }] }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and invoice_id=${kit.q(invoice.id)}`)[0].id
}

// The closing desk's own path: schedule, clear every gate, settle.
function scheduleSale(kit, org, home) {
  const closingId = randomUUID()
  kit.sql(`insert into public.closings(id,org_id,project_id,lot_id,community_id,status,buyer_contact_id,created_by) values(${kit.q(closingId)},${kit.q(org.orgId)},${kit.q(home.projectId)},${kit.q(home.lotId)},${kit.q(org.communityId)},'projected',${kit.q(home.buyerId)},${kit.q(org.owner.userId)})`)
  return closingId
}

async function settle(kit, org, home, date, closingId = scheduleSale(kit, org, home)) {
  const closings = app("closings")
  const status = () => kit.rows(`select status from public.closings where id=${kit.q(closingId)}`)[0].status
  if (status() === "projected") {
    await kit.as(org.owner, () => closings.scheduleClosing({ closingId, scheduledDate: date }))
    for (const item of kit.rows(`select id from public.closing_checklist_items where closing_id=${kit.q(closingId)} and is_gate`))
      await kit.as(org.owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "waived", notes: "Verified at the closing table by the title agent." }))
  }
  if (status() !== "cleared_to_close") await kit.as(org.owner, () => closings.markClearedToClose(closingId))
  // The acceptance stack has no file storage, so filing the signed statement PDF
  // (after the closing is recorded) is the one step allowed to fail here.
  await kit.as(org.owner, () => closings.settleClosing({ closingId, actualDate: date, paymentMethod: "wire", paymentReference: `WIRE-${home.lotNumber}` }))
    .catch((error) => { if (!/^Closing is recorded; retry completion after resolving the statement: Missing R2/.test(error.message)) throw error })
  if (status() !== "closed") throw Error("Closing was not recorded")
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return closingId
}

const HOME_CODES = ["1100", "1170", "2260", "2300", "4000", "5000", "5050"]

// One home built and sold: land, construction, capitalized interest, a deposit
// partly refunded, and a neighbour's deposit that must stay untouched.
async function soldHome(kit, name, input) {
  const org = await builder(kit, name, [{ name: "Lot 1 — Aspen plan", priceCents: input.priceCents }, { name: "Lot 2 — Birch plan", priceCents: input.priceCents }])
  const [home, neighbour] = org.homes
  await landAndStart(kit, org, home, { date: "2026-06-02", startDate: "2026-06-03", cents: input.landCents })
  await bill(kit, org, home.projectId, "2026-06-10", input.constructionCents)
  await capitalizedInterest(kit, org, home, { date: "2026-06-15", paidCents: input.interestPaidCents, eligibleCents: input.interestEligibleCents })
  await kit.as(org.owner, () => app("books/warranty-accounting").setWarrantyReserveEstimate({ projectId: home.projectId, date: "2026-07-01", amountCents: input.warrantyReserveCents, evidenceUrl: `${EVIDENCE}/warranty` }))
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: home.projectId, date: "2026-07-01", evidenceUrl: `${EVIDENCE}/completion` }))
  const ownDeposit = await deposit(kit, org, home, { date: "2026-06-05", cents: input.depositCents })
  await kit.service(() => app("payments").recordPaymentReversal({ paymentId: ownDeposit, amountCents: input.depositRefundCents, reversalType: "refund", reason: "Buyer reduced the earnest deposit", orgId: org.orgId }))
  await kit.drainOutbox(org.orgId)
  await deposit(kit, org, neighbour, { date: "2026-06-06", cents: input.neighbourDepositCents })
  const beforeSale = balances(kit, org, { projectId: home.projectId, codes: HOME_CODES })
  const closingId = await settle(kit, org, home, input.saleDate)
  return { org, home, neighbour, closingId, beforeSale }
}

const depositsHeld = (kit, org, projectId) => -balances(kit, org, { projectId, codes: ["2300"] })["2300"]
const HOME_CONTROLS = ["land_inventory_control", "completed_homes_control", "warranty_reserve_control", "customer_deposits_control"]
async function controls(kit, org, asOf) {
  const rows = await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, asOf))
  return Object.fromEntries(HOME_CONTROLS.map((code) => [code, rows.find((row) => row.code === code)?.status ?? "missing"]))
}

// The sold home's cost leaves inventory by the cost it came from, and only its
// own deposit (net of what was refunded) settles against the sale.
async function saleReliefByComponent(kit, expected, check) {
  const input = expected.inputs
  const { org, home, neighbour, closingId } = await soldHome(kit, "HOME-01 sale relief", input)
  const settlement = kit.rows(`select settlement from public.closings where id=${kit.q(closingId)}`)[0].settlement
  check.equal("the sale is relieved by component, nothing is left in inventory, and only the home's own deposit settles", expected.expected, {
    costOfSalesByComponent: reliefByComponent(kit, org, home.projectId),
    inventoryLeft: balances(kit, org, { projectId: home.projectId, codes: ["1160", "1170"] }),
    landLeft: balances(kit, org, { lotId: home.lotId, codes: ["1120"] })["1120"],
    depositsApplied: settlement.depositsApplied.map((row) => row.amountCents),
    homeDepositsHeld: depositsHeld(kit, org, home.projectId),
    neighbourDepositsHeld: depositsHeld(kit, org, neighbour.projectId),
    revenue: -balances(kit, org, { projectId: home.projectId, codes: ["4000"] })["4000"],
    controlsTie: await controls(kit, org, "2026-07-31"),
  })
  return { orgId: org.orgId, closingId }
}

// A cost dated before the sale but entered after it is relieved on the sale
// date while that month is open; a cost dated after the sale is the sold home's
// period cost, expensed and labeled; a cost dated into a closed sale month
// waits on that month and never rewrites it.
async function costsAfterTheSale(kit, expected, check) {
  const input = expected.inputs
  const { org, home } = await soldHome(kit, "HOME-01 costs after the sale", input)
  await bill(kit, org, home.projectId, input.lateCostDate, input.lateCostCents, "Final grade")
  const lateRelief = kit.rows(`select e.entry_date::text date, coalesce(sum(l.debit_cents),0)::bigint n from public.journal_entries e join public.journal_lines l on l.entry_id=e.id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${kit.q(org.orgId)} and e.source_type='inventory_sale_relief' and e.source_id=${kit.q(home.projectId)} and a.code='5000' group by e.id, e.entry_date order by e.created_at`)
  const postSaleBill = await bill(kit, org, home.projectId, input.postSaleCostDate, input.postSaleCostCents, "Punch touch-up")
  const postSale = kit.rows(`select a.code, l.dimensions->>'closed_home_cost' tagged from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
    where e.org_id=${kit.q(org.orgId)} and e.source_id=${kit.q(postSaleBill)} and e.status='posted' and l.debit_cents>0`)[0]
  const { closeAccountingPeriod, runBooksCloseChecklist } = app("books/period-close")
  // Receipts still in undeposited funds at month end are supported as deposited in August.
  const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
  const julyId = org.periods["2026-07"].periodId
  const clearing = await kit.as(org.owner, () => getClearingSupportWorkspace(julyId))
  await kit.as(org.owner, () => reviewClearingSupport({ periodId: julyId, ledgerDigest: clearing.ledgerDigest, items: clearing.balances.filter((row) => row.balanceCents !== 0).map((row) => ({
    code: row.code, amountCents: row.balanceCents, expectedSettlementDate: "2026-08-03", explanation: "Deposits and the closing wire deposited August 3", evidenceUrl: `${EVIDENCE}/deposit-0803.pdf` })) }))
  const checklist = await kit.as(org.owner, () => runBooksCloseChecklist(julyId))
  const julyBlocking = checklist.blockingFailures.map((row) => row.code ?? row.label)
  await kit.as(org.owner, () => closeAccountingPeriod(org.periods["2026-07"].periodId))
  const closedCostOfSales = balances(kit, org, { projectId: home.projectId, codes: ["5000"], asOf: "2026-07-31" })["5000"]
  const blockedBill = await bill(kit, org, home.projectId, input.blockedCostDate, input.blockedCostCents, "Missed invoice")
  const projection = await project(kit, org)
  await kit.service(() => app("books/reconciliation").recordProjectionFailures([{ orgId: org.orgId, ...projection }], { full: true }))
  check.equal("each cost after the sale follows the stated policy and the closed month is never rewritten", expected.expected, {
    lateCostRelievedOn: lateRelief.slice(1).map((row) => ({ date: row.date, cents: Number(row.n) })),
    postSaleCost: { account: postSale.code, labeledClosedHomeCost: postSale.tagged === "true" },
    julyBlockingFailures: julyBlocking,
    closedMonthCostOfSalesUnchanged: balances(kit, org, { projectId: home.projectId, codes: ["5000"], asOf: "2026-07-31" })["5000"] === closedCostOfSales,
    blockedCostWaits: kit.rows(`select count(*)::int n from public.journal_entries where org_id=${kit.q(org.orgId)} and source_id=${kit.q(blockedBill)} and status='posted'`)[0].n === 0,
    blockedFinding: kit.rows(`select category from public.accounting_reconciliation_items where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(blockedBill)} and status<>'resolved'`).map((row) => row.category),
  })
  return { orgId: org.orgId }
}

// Shared site cost reaches lots only through a proposal a different member
// approves; the shares follow the basis and add back to the cent.
async function reviewedDevelopmentAllocation(kit, expected, check) {
  const input = expected.inputs
  const org = await builder(kit, "HOME-01 development allocation", [])
  const inventory = app("books/inventory")
  await kit.as(org.owner, () => inventory.enableProjectInventory({ projectId: org.developmentId, effectiveOn: "2026-06-01", evidenceUrl: `${EVIDENCE}/development` }))
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date: "2026-06-02", allocations: org.developmentLotIds.map((lotId) => ({ lotId, amountCents: input.landPerLotCents })), cashAccountId: glId(kit, org, "1000"), cashCents: input.landPerLotCents * 3, debtInstrumentId: null, debtCents: 0, reference: "Cedar Ridge takedown", evidenceUrl: `${EVIDENCE}/takedown` }))
  await bill(kit, org, org.developmentId, "2026-06-10", input.siteCostCents, "Site utilities")
  const proposal = { projectId: org.developmentId, date: "2026-06-20", reference: "Cedar Ridge phase 1 utilities", basis: "front_footage", totalCents: input.allocateCents,
    weights: org.developmentLotIds.map((lotId, index) => ({ lotId, weight: input.frontFootage[index] })), evidenceUrl: `${EVIDENCE}/allocation`, note: "Utilities run along the street frontage of each lot." }
  const { id } = await kit.as(org.reviewer, () => inventory.proposeDevelopmentAllocation(proposal))
  const postedBeforeReview = Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${kit.q(org.orgId)} and source_type='inventory_development_allocation'`)[0].n)
  const selfApproval = await refusal(() => kit.as(org.reviewer, () => inventory.reviewDevelopmentAllocation({ allocationId: id, approve: true })))
  await kit.as(org.owner, () => inventory.reviewDevelopmentAllocation({ allocationId: id, approve: true }))
  const shares = kit.rows(`select shares from public.books_development_allocations where id=${kit.q(id)}`)[0].shares
  check.equal("the allocation posts only after independent review, in exact cents that follow the basis", expected.expected, {
    postedBeforeReview,
    selfApproval: /someone other than/.test(selfApproval) ? "refused: approved by someone other than the proposer" : selfApproval,
    shares: shares.map((share) => Number(share.amount_cents)).sort((a, b) => b - a),
    sharesAddToTotal: shares.reduce((sum, share) => sum + Number(share.amount_cents), 0) === input.allocateCents,
    landByLot: org.developmentLotIds.map((lotId) => balances(kit, org, { lotId, codes: ["1120"] })["1120"]).sort((a, b) => b - a),
    developmentLeft: balances(kit, org, { projectId: org.developmentId, codes: ["1160"] })["1160"],
    controlsTie: await controls(kit, org, "2026-06-30"),
  })
  return { orgId: org.orgId, allocationId: id }
}

// Warranty work on a sold home consumes the reserve and credits the account the
// cost was booked to, so cost of sales is not overstated and the reserve ties.
async function warrantyConsumption(kit, expected, check) {
  const input = expected.inputs
  const { org, home } = await soldHome(kit, "HOME-01 warranty", input)
  const requestId = randomUUID(), visitId = randomUUID()
  kit.sql(`begin;
insert into public.warranty_requests(id,org_id,project_id,title,request_number) values(${kit.q(requestId)},${kit.q(org.orgId)},${kit.q(home.projectId)},'Drywall crack',1);
insert into public.warranty_service_visits(id,org_id,request_id,project_id,visit_number,assignee_kind,assigned_user_id,window_start,window_end,status) values(${kit.q(visitId)},${kit.q(org.orgId)},${kit.q(requestId)},${kit.q(home.projectId)},1,'tech',${kit.q(org.owner.userId)},'2026-08-10 14:00Z','2026-08-10 16:00Z','completed');
commit;`)
  const repair = await bill(kit, org, home.projectId, "2026-08-10", input.repairCents, "Drywall repair")
  const source = kit.rows(`select id from public.job_cost_entries where org_id=${kit.q(org.orgId)} and project_id=${kit.q(home.projectId)} and status='posted' and incurred_on='2026-08-10'`)[0].id
  const costBefore = balances(kit, org, { projectId: home.projectId, codes: ["5000", "5050", "2260"] })
  await kit.as(org.owner, () => app("books/warranty-accounting").approveWarrantyAccounting({ visitId, date: "2026-08-12", evidenceUrl: `${EVIDENCE}/visit`, sources: [{ jobCostEntryId: source, amountCents: input.repairCents }] }))
  const costAfter = balances(kit, org, { projectId: home.projectId, codes: ["5000", "5050", "2260"] })
  check.equal("the reserve absorbs the repair against the account the cost was booked to, and the reserve ties", expected.expected, {
    reserveProvided: -costBefore["2260"],
    change: sorted(Object.fromEntries(Object.keys(costAfter).map((code) => [code, costAfter[code] - costBefore[code]]))),
    repairBill: Boolean(repair),
    controlsTie: await controls(kit, org, "2026-08-31"),
  })
  return { orgId: org.orgId, visitId }
}

// Reversing a recorded closing returns the home to inventory component by
// component, takes the sale and its collections back, returns the deposit to the
// buyer's liability and withdraws the warranty provision.
async function closingReversal(kit, expected, check) {
  const input = expected.inputs
  const { org, home, neighbour, closingId, beforeSale } = await soldHome(kit, "HOME-01 closing reversal", input)
  const wrongDate = await refusal(() => kit.as(org.owner, () => app("closings").reverseClosing({ closingId, reason: "x", date: input.reversalDate })))
  await kit.as(org.owner, () => app("closings").reverseClosing({ closingId, reason: "Buyer financing fell through after funding; title returned.", date: input.reversalDate }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const after = balances(kit, org, { projectId: home.projectId, codes: HOME_CODES })
  const closing = kit.rows(`select c.status, s.books_inventory_sold_on, l.status lot_status from public.closings c join public.project_financial_settings s on s.project_id=c.project_id join public.lots l on l.id=c.lot_id where c.id=${kit.q(closingId)}`)[0]
  check.equal("the reversal puts the home's books back to where they stood before the sale", expected.expected, {
    shortReason: /Say why/.test(wrongDate) ? "refused: say why" : wrongDate,
    restored: sorted(Object.fromEntries(HOME_CODES.map((code) => [code, after[code] === beforeSale[code]]))),
    componentsReturned: reliefByComponent(kit, org, home.projectId),
    closing: { status: closing.status, soldOn: closing.books_inventory_sold_on, lot: closing.lot_status },
    neighbourDepositsHeld: depositsHeld(kit, org, neighbour.projectId),
    controlsTie: await controls(kit, org, "2026-08-31"),
  })
  return { orgId: org.orgId, closingId }
}

// Under the closing method an invoice is a sale document, earned when issued.
// The closing invoice bills the home's whole price, so settlement is refused
// while an ordinary invoice on the home would count part of it twice. Credited,
// the home closes and earns its price exactly once; an invoice after the sale is
// earned when issued.
async function invoiceBeforeClosing(kit, expected, check) {
  const input = expected.inputs
  const org = await builder(kit, "HOME-01 invoice before closing", [{ name: "Lot 1 — Aspen plan", priceCents: input.priceCents }])
  const [home] = org.homes
  await landAndStart(kit, org, home, { date: "2026-06-02", startDate: "2026-06-03", cents: input.landCents })
  await bill(kit, org, home.projectId, "2026-06-10", input.constructionCents)
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: home.projectId, date: "2026-07-01", evidenceUrl: `${EVIDENCE}/completion` }))
  const invoice = (date, cents, title) => kit.as(org.owner, () => app("invoices").createInvoice({ input: { project_id: home.projectId, invoice_number: `UP-${randomUUID().slice(0, 6)}`, customer_id: home.buyerId,
    title, issue: true, issue_date: date, due_date: date, tax_rate: 0, sent_to_emails: [`buyer-${home.lotNumber}@acceptance.example.test`],
    lines: [{ description: title, quantity: 1, unit_cost: cents / 100, taxable: false }] } }))
  const upgrade = await invoice(input.upgradeDate, input.upgradeCents, "Kitchen upgrade")
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const beforeSale = balances(kit, org, { projectId: home.projectId, codes: ["1100", "2350", "4000"] })
  const closingId = scheduleSale(kit, org, home)
  const refused = await refusal(() => settle(kit, org, home, input.saleDate, closingId))
  await kit.as(org.owner, () => app("receivable-adjustments").createReceivableAdjustment({ invoiceId: upgrade.id, adjustmentType: "credit_memo", amountCents: input.upgradeCents, effectiveDate: input.creditDate, reason: "Upgrade moves onto the closing statement", idempotencyKey: randomUUID() }))
  await kit.drainOutbox(org.orgId)
  await settle(kit, org, home, input.saleDate, closingId)
  const atSale = balances(kit, org, { projectId: home.projectId, codes: ["1100", "2350", "4000"] })
  await invoice(input.afterSaleDate, input.afterSaleCents, "Fence added after closing")
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  check.equal("the closing waits for the earlier invoice to be credited; revenue is the price once, then the later invoice", expected.expected, {
    beforeSale, refusedWhileOpen: /outside the closing statement/.test(refused) ? "refused" : refused, atSale,
    afterLaterInvoice: balances(kit, org, { projectId: home.projectId, codes: ["1100", "2350", "4000"] }),
  })
  return { orgId: org.orgId, closingId, refused }
}

module.exports = {
  subcases: {
    "sale-relief-by-component": saleReliefByComponent,
    "costs-after-the-sale": costsAfterTheSale,
    "reviewed-development-allocation": reviewedDevelopmentAllocation,
    "warranty-consumption": warrantyConsumption,
    "closing-reversal": closingReversal,
    "invoice-before-closing": invoiceBeforeClosing,
  },
}
module.exports.helpers = { builder, bill, landAndStart, capitalizedInterest, deposit, settle, balances, reliefByComponent, controls, depositsHeld }
