// TRADE-EXP-01 — receipts without a job (TR05-01 .. TR05-03). The seeded electrical company puts Arc Books on its
// ledger with one company card, and its people capture receipts from the iOS app with no job: a crew member's fuel
// receipt and the foreman's supply-house receipt land in overhead; the office approves them and Books posts each
// to its category account (never job cost); the fuel charge on the card feed is matched to its receipt and a
// charge nobody receipted stays on the review list; the supply-house receipt is reassigned to a job, and its cost
// leaves overhead and posts to that job. The mobile route handlers are called as the app calls them (bearer token
// from a real sign-in); the office is the owner through the services the expense desk and Books banking call.
// The stack has no object storage, so a receipt image is not attached to either capture.
//
//   fuel-receipt-captured-on-mobile-lands-in-overhead   no job: the row is overhead, unbillable and submitted, retried capture is one row, the desk queues
//   approved-overhead-posts-to-its-category-account     approval posts the category account against the card, never job cost
//   fuel-charge-matches-its-receipt-on-the-card-feed    the feed's charge matches the receipt's posting once; a charge without a receipt stays unmatched; unmatching puts it back
//   supply-receipt-moves-from-overhead-to-a-job         reassigning posts the job's cost, moves the ledger, and the audit keeps both homes
//   unauthorized-members-cannot-approve-or-move         a crew member cannot approve or reassign, and a stale screen cannot move an expense
const { randomUUID } = require("node:crypto")
const { tradeCompany, signIn } = require("../trade-seed.cjs")
const { app, monthBounds, project } = require("./shared.cjs")

const A = (path) => require(`../../../${path}`)
const today = () => new Date().toISOString().slice(0, 10)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 160)}` } }
const glId = (kit, orgId, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(orgId)} and code=${kit.q(code)}`)[0].id

const FUEL = { dollars: 84.25, cents: 8_425, vendor: "Shell", description: "Diesel, truck 4", category: "fuel_vehicles" }
const SUPPLY = { dollars: 212.6, cents: 21_260, vendor: "Graybar Electric", description: "Breakers and wire nuts for the Palm Court service call", category: "shop_supplies" }
const DECOY = { dollars: 12.4, cents: 1_240, description: "CORNER COFFEE 0042" }

/** The app's capture: a multipart POST to /expenses, a payload and no receipt image (the stack has no object storage). */
async function capture(kit, actor, expense, clientId) {
  const handler = require("../../../app/api/mobile/v1/expenses/route").POST
  const form = new FormData()
  form.set("payload", JSON.stringify({ client_id: clientId, overhead_category: expense.category, expense_date: today(), amount_dollars: expense.dollars, vendor_name: expense.vendor, payment_method: "company_card", description: expense.description }))
  const token = await signIn(kit, actor)
  const response = await handler(new Request("http://127.0.0.1/api/mobile/v1/expenses", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-arc-organization-id": actor.orgId }, body: form }))
  await kit.settle()
  return { status: response.status, body: JSON.parse(await response.text()) }
}

const WORLDS = new WeakMap()
/** The company on Arc Books with one company card, then each stage of the flow once, on the one before it. */
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, (async () => {
    const t = await tradeCompany(kit)
    const { q } = kit
    const owner = t.actors.owner
    const { CONSTRUCTION_CHART_TEMPLATE } = app("books/chart-of-accounts")
    kit.sql(`begin;
insert into public.books_settings(org_id,workspace_enabled,ledger_authority,arc_ledger_mode,external_sync_posture,functional_currency,reporting_basis,active_policy_version,created_by,updated_by)
  values(${q(t.orgId)},true,'external','shadow','normal','usd','accrual',1,${q(owner.userId)},${q(owner.userId)});
${CONSTRUCTION_CHART_TEMPLATE.map((a) => `insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active,created_by,updated_by) values(${q(t.orgId)},${q(a.code)},${q(a.name)},${q(a.accountType)},${q(a.subtype)},${q(a.normalBalance)},${q(a.cashFlowCategory ?? null)},${a.system},true,${q(owner.userId)},${q(owner.userId)});`).join("\n")}
commit;`)
    const bounds = monthBounds(new Date().toISOString().slice(0, 7))
    await kit.as(owner, () => app("books/period-close").createAccountingPeriod({ periodStart: bounds.periodStart, periodEnd: bounds.periodEnd, fiscalYear: bounds.year, fiscalPeriod: bounds.month }))
    await kit.as(owner, () => app("books/bank-feeds").createManualBankAccount({ name: "Fuel and supplies card", accountType: "credit", glAccountId: glId(kit, t.orgId, "2100") }))
    const { launchGreenfieldBooks, GREENFIELD_ATTESTATION } = app("books/greenfield")
    await kit.as(owner, () => launchGreenfieldBooks({ launchedOn: bounds.periodStart, openingPosition: "zero", attestation: GREENFIELD_ATTESTATION }))
    return { t, owner, bankAccountId: kit.rows(`select id from public.bank_accounts where org_id=${q(t.orgId)}`)[0].id, stages: {} }
  })())
  return WORLDS.get(kit)
}

function stage(kit, name, build) {
  return world(kit).then((w) => (w.stages[name] ??= build(w)))
}

const moveOf = (kit, id) => kit.rows(`select project_id, overhead_category, is_billable, status, receipt_file_id is not null has_receipt, submitted_by_user_id, amount_cents::int amount, tax_cents::int tax, vendor_name_text vendor, payment_method from public.project_expenses where id=${kit.q(id)}`)[0]
const deskRow = (desk, id) => desk.rows.find((row) => row.id === id)

// ---------------------------------------------------------------------------
// Stage 1: capture on the phone

const captured = (kit) => stage(kit, "captured", async (w) => {
  const crew = w.t.actors.crew, foreman = w.t.actors.foreman
  const fuelId = randomUUID(), supplyId = randomUUID()
  const fuel = await capture(kit, crew, FUEL, fuelId)
  const retry = await capture(kit, crew, FUEL, fuelId)
  const supply = await capture(kit, foreman, SUPPLY, supplyId)
  const mine = await require("../trade-seed.cjs").mobileCall(kit, crew, "expenses")
  const desk = (queue) => kit.as(w.owner, () => A("lib/services/org-expenses").loadOrgExpenseDesk({ queue }))
  return { fuelId, supplyId, fuel, retry, supply, mine, review: await desk("review"), overhead: await desk("overhead"), unsorted: await desk("unsorted") }
})

async function fuelReceiptLandsInOverhead(kit, spec, check) {
  const w = await world(kit)
  const s = await captured(kit)
  const { q } = kit
  const fuel = moveOf(kit, s.fuelId)
  const copies = Number(kit.rows(`select count(*)::int n from public.project_expenses where org_id=${q(w.t.orgId)} and id=${q(s.fuelId)}`)[0].n)
  const row = deskRow(s.overhead, s.fuelId)
  const observed = {
    capture: { status: s.fuel.status, home: s.fuel.body.data.home_label, project: s.fuel.body.data.project_id, category: s.fuel.body.data.overhead_category, amountCents: s.fuel.body.data.amount_cents, state: s.fuel.body.data.status },
    retriedCapture: { status: s.retry.status, sameExpense: s.retry.body.data.id === s.fuelId, rows: copies },
    stored: { overheadCategory: fuel.overhead_category, onAJob: fuel.project_id !== null, billable: fuel.is_billable, status: fuel.status, capturedByTheCrewMember: fuel.submitted_by_user_id === w.t.actors.crew.userId, vendor: fuel.vendor, amountCents: fuel.amount, taxCents: fuel.tax, paidBy: fuel.payment_method, hasReceiptImage: fuel.has_receipt },
    crewSeesItInMyExpenses: s.mine.status === 200 && s.mine.body.data.some((entry) => entry.id === s.fuelId && entry.home_label === "Fuel and vehicles"),
    officeDesk: { reviewQueueHoldsBoth: [s.fuelId, s.supplyId].every((id) => deskRow(s.review, id)), unsorted: s.unsorted.rows.length, overheadQueue: s.overhead.rows.map((entry) => entry.homeLabel).sort(), fuelRow: row && { home: row.homeLabel, submittedBy: row.submittedBy, totalCents: row.totalCents, status: row.status }, counts: s.overhead.counts },
  }
  check.equal("a crew member's no-job fuel receipt captured on the phone is an unbillable submitted overhead expense under Fuel and vehicles, a retry with the same client id is the same one row, and the office sees it with the foreman's supply receipt in the review and overhead queues and nothing unsorted", spec.expected, observed)
  return { orgId: w.t.orgId, expenseId: s.fuelId }
}

// ---------------------------------------------------------------------------
// Stage 2: approval posts to the ledger

const approved = (kit) => stage(kit, "approved", async (w) => {
  const s = await captured(kit)
  const expenses = A("lib/services/org-expenses")
  for (const id of [s.fuelId, s.supplyId]) await kit.as(w.owner, () => expenses.approveOrgExpense({ expense_id: id }))
  const books = { org: { orgId: w.t.orgId } }
  const projection = await project(kit, books.org)
  return { ...s, projection }
})

async function approvedOverheadPostsToItsCategoryAccount(kit, spec, check) {
  const w = await world(kit)
  const s = await approved(kit)
  const { q } = kit
  const source = (id) => `e.source_type='expense' and e.source_id=${q(id)}`
  const entries = (id) => Number(kit.rows(`select count(*)::int n from public.journal_entries e where e.org_id=${q(w.t.orgId)} and ${source(id)} and e.status='posted'`)[0].n)
  const jobCost = Number(kit.rows(`select count(*)::int n from public.job_cost_entries where org_id=${q(w.t.orgId)} and source_type='project_expense' and source_id in (${q(s.fuelId)}, ${q(s.supplyId)})`)[0].n)
  const observed = {
    status: [moveOf(kit, s.fuelId).status, moveOf(kit, s.supplyId).status],
    projectionFailures: s.projection.failures.length,
    fuelPosting: { entries: entries(s.fuelId), netDebitCentsByAccount: kit.postedNet(w.t.orgId, source(s.fuelId)) },
    supplyPosting: { entries: entries(s.supplyId), netDebitCentsByAccount: kit.postedNet(w.t.orgId, source(s.supplyId)) },
    jobCostEntries: jobCost,
  }
  check.equal("approving the two overhead receipts posts each once, debiting its category account (6200 fuel, 6220 shop supplies) and crediting the company card (2100), with no job cost", spec.expected, observed)
  return { orgId: w.t.orgId }
}

// ---------------------------------------------------------------------------
// Stage 3: the card feed

const feed = (kit) => stage(kit, "feed", async (w) => {
  const s = await approved(kit)
  const { q } = kit
  const books = A("lib/services/books/bank-reconciliation")
  const banking = A("lib/services/books/banking-workspace")
  const csv = ["Date,Description,Amount,Id", `${today()},SHELL OIL 5731,${FUEL.dollars.toFixed(2)},fuel-1`, `${today()},${DECOY.description},${DECOY.dollars.toFixed(2)},coffee-1`].join("\n")
  await kit.as(w.owner, () => A("lib/services/books/bank-feeds").importBankStatement({ bankAccountId: w.bankAccountId, contents: csv, positiveDirection: "outflow", fileName: "card.csv" }))
  const unmatchedBefore = await kit.as(w.owner, () => banking.loadUnmatchedCapturedExpenses())
  const tray = await kit.as(w.owner, () => books.reviewUnmatchedBankTransactions({ bankAccountId: w.bankAccountId }))
  const transaction = (text) => kit.rows(`select id from public.bank_transactions where org_id=${q(w.t.orgId)} and description=${q(text)}`)[0].id
  const fuelRow = tray.rows.find((row) => row.transactionId === transaction("SHELL OIL 5731"))
  const decoyRow = tray.rows.find((row) => row.transactionId === transaction(DECOY.description))
  await kit.as(w.owner, () => books.confirmBankMatch({ bankTransactionId: fuelRow.transactionId, journalLineId: fuelRow.best.journalLineId, amountCents: fuelRow.amountCents, matchType: "suggested", confidence: fuelRow.best.confidence }))
  const unmatchedAfter = await kit.as(w.owner, () => banking.loadUnmatchedCapturedExpenses())
  const matched = kit.rows(`select status, matched_amount_cents::int cents, match_type from public.bank_transaction_matches where org_id=${q(w.t.orgId)} and bank_transaction_id=${q(fuelRow.transactionId)}`)
  const entriesAfterMatch = Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${q(w.t.orgId)} and status='posted' and source_type in ('expense','bank_transaction')`)[0].n)
  const version = Number(kit.rows(`select coalesce((select version from public.bank_transaction_details where org_id=${q(w.t.orgId)} and transaction_id=${q(fuelRow.transactionId)}), 0) v`)[0].v)
  await kit.as(w.owner, () => banking.mutateBankingTransaction({ transactionId: fuelRow.transactionId, version, action: "undo" }))
  const unmatchedUndone = await kit.as(w.owner, () => banking.loadUnmatchedCapturedExpenses())
  const afterUndo = kit.rows(`select status from public.bank_transaction_matches where org_id=${q(w.t.orgId)} and bank_transaction_id=${q(fuelRow.transactionId)} order by created_at`).map((row) => row.status)
  const entriesAfterUndo = Number(kit.rows(`select count(*)::int n from public.journal_entries where org_id=${q(w.t.orgId)} and status='posted' and source_type in ('expense','bank_transaction')`)[0].n)
  // The match stays, as a person would leave it.
  await kit.as(w.owner, () => books.confirmBankMatch({ bankTransactionId: fuelRow.transactionId, journalLineId: fuelRow.best.journalLineId, amountCents: fuelRow.amountCents, matchType: "suggested", confidence: fuelRow.best.confidence }))
  const unmatchedFinal = await kit.as(w.owner, () => banking.loadUnmatchedCapturedExpenses())
  return { ...s, unmatchedBefore, fuelRow, decoyRow, unmatchedAfter, matched, entriesAfterMatch, entriesAfterUndo, unmatchedUndone, afterUndo, unmatchedFinal, fuelTransactionId: fuelRow.transactionId }
})

const unmatchedView = (list) => list.rows.map((row) => ({ vendor: row.vendorName, home: row.homeLabel, cents: row.amountCents, hasReceipt: row.hasReceipt })).sort((a, b) => a.cents - b.cents)

async function fuelChargeMatchesItsReceipt(kit, spec, check) {
  const w = await world(kit)
  const s = await feed(kit)
  const observed = {
    receiptsNotYetOnTheFeed: unmatchedView(s.unmatchedBefore),
    fuelCharge: { suggestedFromTheReceiptsPosting: Boolean(s.fuelRow.best), confidence: s.fuelRow.best?.confidence, amountCents: s.fuelRow.amountCents, direction: s.fuelRow.direction, sameDay: s.fuelRow.best?.bankDate === s.fuelRow.best?.journalDate },
    chargeWithoutAReceipt: { amountCents: s.decoyRow.amountCents, suggestion: s.decoyRow.best },
    afterMatching: { receiptsNotYetOnTheFeed: unmatchedView(s.unmatchedAfter), matches: s.matched, postedExpenseAndBankEntries: s.entriesAfterMatch },
    afterUnmatching: { receiptsNotYetOnTheFeed: unmatchedView(s.unmatchedUndone), matchStatuses: s.afterUndo, postedExpenseAndBankEntries: s.entriesAfterUndo },
    matchedAgain: { receiptsNotYetOnTheFeed: unmatchedView(s.unmatchedFinal) },
  }
  check.equal("the card-feed charge matches the fuel receipt's posting (no new entry), the coffee charge nobody receipted has no suggestion, the unmatched-receipts list drops the matched fuel and keeps the supply receipt, and unmatching reverses the match and lists the fuel receipt again", spec.expected, observed)
  return { orgId: w.t.orgId, bankTransactionId: s.fuelTransactionId }
}

// ---------------------------------------------------------------------------
// Stage 4: the supply-house receipt goes to a job

const reassigned = (kit) => stage(kit, "reassigned", async (w) => {
  const s = await feed(kit)
  const expenses = A("lib/services/org-expenses")
  const desk = await kit.as(w.owner, () => expenses.loadOrgExpenseDesk({ queue: "overhead" }))
  const row = deskRow(desk, s.supplyId)
  const job = w.t.jobs.homeowner
  const stale = await attempt(() => kit.as(w.owner, () => expenses.assignExpenseHome({ expense_id: s.supplyId, project_id: job, overhead_category: null, expected_updated_at: "2020-01-01T00:00:00+00:00" })))
  const result = await kit.as(w.owner, () => expenses.assignExpenseHome({ expense_id: s.supplyId, project_id: job, overhead_category: null, expected_updated_at: row.updatedAt }))
  await kit.drainOutbox(w.t.orgId)
  const projection = await project(kit, { orgId: w.t.orgId })
  return { ...s, job, stale, result, projection, before: row }
})

async function supplyReceiptMovesToAJob(kit, spec, check) {
  const w = await world(kit)
  const s = await reassigned(kit)
  const { q } = kit
  const row = moveOf(kit, s.supplyId)
  const costs = kit.rows(`select project_id=${q(s.job)} on_the_job, cost_cents::int cents, status from public.job_cost_entries where org_id=${q(w.t.orgId)} and source_type='project_expense' and source_id=${q(s.supplyId)}`)
  const fuelCosts = Number(kit.rows(`select count(*)::int n from public.job_cost_entries where org_id=${q(w.t.orgId)} and source_type='project_expense' and source_id=${q(s.fuelId)}`)[0].n)
  const audit = kit.rows(`select before_data->>'overhead_category' from_category, before_data->>'project_id' from_project, after_data->>'overhead_category' to_category, after_data->>'project_id'=${q(s.job)} to_job from public.audit_log where org_id=${q(w.t.orgId)} and entity_type='project_expense' and entity_id=${q(s.supplyId)} and action='update' and (before_data->>'project_id') is null and (after_data->>'project_id') is not null`)
  const event = kit.rows(`select payload->>'from_overhead_category' from_category, payload->>'project_id'=${q(s.job)} to_job, (payload->>'amount_cents')::int cents from public.events where org_id=${q(w.t.orgId)} and event_type='expense_reassigned' and entity_id=${q(s.supplyId)}`)
  const desk = await kit.as(w.owner, () => A("lib/services/org-expenses").loadOrgExpenseDesk({ queue: "overhead" }))
  const observed = {
    staleScreen: s.stale,
    expense: { onTheJob: row.project_id === s.job, overheadCategory: row.overhead_category, billable: row.is_billable, status: row.status },
    jobCost: costs,
    ledger: {
      projectionFailures: s.projection.failures.length,
      // A revised expense retires its old entry (status reversed) and posts the new one; only posted entries are the books.
      entries: kit.rows(`select e.status, (select a.code from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.entry_id=e.id and l.debit_cents>0) debit_account from public.journal_entries e where e.org_id=${q(w.t.orgId)} and e.source_type='expense' and e.source_id=${q(s.supplyId)} order by e.created_at`).map((entry) => ({ status: entry.status, debitAccount: entry.debit_account })),
      postedNetDebitCentsByAccount: Object.fromEntries(kit.rows(`select a.code, sum(l.debit_cents - l.credit_cents)::bigint net from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id where l.org_id=${q(w.t.orgId)} and e.status='posted' and e.source_type='expense' and e.source_id=${q(s.supplyId)} group by a.code having sum(l.debit_cents - l.credit_cents)<>0 order by a.code`).map((row) => [row.code, Number(row.net)])),
    },
    fuelReceiptUntouched: { overheadCategory: moveOf(kit, s.fuelId).overhead_category, jobCostEntries: fuelCosts },
    audit,
    event,
    overheadQueueNow: desk.rows.map((entry) => entry.homeLabel).sort(),
    thisMonth: { overheadCents: desk.month.overheadCents, jobCostCents: desk.month.jobCostCents, byCategory: desk.month.byCategory.map((entry) => ({ label: entry.label, cents: entry.cents })) },
  }
  check.equal("reassigning the approved supply-house receipt to a job refuses a stale screen, posts the job's cost entry, leaves nothing in overhead for it, re-posts the ledger from the job (job cost, not shop supplies), keeps both homes in the audit and event, and the desk's month splits overhead from job cost", spec.expected, observed)
  return { orgId: w.t.orgId, expenseId: s.supplyId, projectId: s.job }
}

// ---------------------------------------------------------------------------
// Authorization

async function unauthorizedMembersCannotApproveOrMove(kit, spec, check) {
  const w = await world(kit)
  await reassigned(kit)
  const crew = w.t.actors.crew
  const expenses = A("lib/services/org-expenses")
  const freshId = randomUUID()
  const fresh = await capture(kit, w.t.actors.foreman, { ...FUEL, dollars: 40, description: "Fuel for the lift" }, freshId)
  const desk = await kit.as(w.owner, () => expenses.loadOrgExpenseDesk({ queue: "review" }))
  const updatedAt = deskRow(desk, freshId).updatedAt
  const observed = {
    freshCapture: fresh.status,
    crewApproves: await attempt(() => kit.as(crew, () => expenses.approveOrgExpense({ expense_id: freshId }))),
    crewMoves: await attempt(() => kit.as(crew, () => expenses.assignExpenseHome({ expense_id: freshId, project_id: null, overhead_category: "other", expected_updated_at: updatedAt }))),
    crewReadsTheDesk: await attempt(() => kit.as(crew, () => expenses.loadOrgExpenseDesk({}))),
    stillSubmittedInFuel: { status: moveOf(kit, freshId).status, category: moveOf(kit, freshId).overhead_category },
    officeApprovesWithNoHome: await attempt(async () => {
      const unsorted = randomUUID()
      const handler = require("../../../app/api/mobile/v1/expenses/route").POST
      const form = new FormData()
      form.set("payload", JSON.stringify({ client_id: unsorted, expense_date: today(), amount_dollars: 9.5, vendor_name: "Corner store", payment_method: "company_card" }))
      const response = await handler(new Request("http://127.0.0.1/api/mobile/v1/expenses", { method: "POST", headers: { authorization: `Bearer ${await signIn(kit, w.t.actors.foreman)}`, "x-arc-organization-id": w.t.orgId }, body: form }))
      if (response.status !== 201) throw Error(`capture ${response.status}`)
      await kit.as(w.owner, () => expenses.approveOrgExpense({ expense_id: unsorted }))
    }),
  }
  check.equal("a crew member cannot approve, reassign or read the office expense desk; an unsorted capture (no job, no category) cannot be approved until it has a home", spec.expected, observed)
  return { orgId: w.t.orgId }
}

module.exports = {
  id: "TRADE-EXP-01",
  subcases: {
    "fuel-receipt-captured-on-mobile-lands-in-overhead": fuelReceiptLandsInOverhead,
    "approved-overhead-posts-to-its-category-account": approvedOverheadPostsToItsCategoryAccount,
    "fuel-charge-matches-its-receipt-on-the-card-feed": fuelChargeMatchesItsReceipt,
    "supply-receipt-moves-from-overhead-to-a-job": supplyReceiptMovesToAJob,
    "unauthorized-members-cannot-approve-or-move": unauthorizedMembersCannotApproveOrMove,
  },
}
