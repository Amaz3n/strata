// TRADE-TM-01 — a homeowner time-and-materials job (TR02-05, TR03-01). The Arc Trade company from
// trade-seed.cjs (its own organization for this scenario) does a day of service work on Henry
// Homeowner's Palm Court job: two crew members clock six hours each against the job's labor cost
// code, the office enters a $340 supply-house receipt against the material code, the office makes a
// T&M ticket of the day's costs, the homeowner signs it on its /t link, the signed ticket becomes the
// invoice, and the invoice is paid by card. Labor and material post to the job's costs throughout.
//
//   crew-hours-and-supply-receipt-become-billable-costs   approved labor and the receipt become open
//                                                         billable costs at the job's rates
//   tm-ticket-is-signed-on-its-link                       the ticket gathers the day's costs, the token
//                                                         page shows it, signing is once and
//                                                         invoicing needs it
//   invoice-is-generated-from-the-signed-ticket           the ticket's costs become one invoice at the
//                                                         ticket's total, issued to the homeowner
//   card-settlement-pays-the-invoice                      the settlement a card payment sends marks the
//                                                         invoice paid at its net
//   labor-and-material-post-to-the-job                    job cost carries the labor and the material
//                                                         at cost, against the budget's codes
const { tradeCompany } = require("../trade-seed.cjs")
const { app } = require("./shared.cjs")

const DAY = "2026-10-12"
const HOURS = 6

const STAGES = new WeakMap()
function stage(kit, name, build) {
  if (!STAGES.has(kit)) STAGES.set(kit, new Map())
  const stages = STAGES.get(kit)
  if (!stages.has(name)) stages.set(name, build())
  return stages.get(name)
}
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 140)}` } }

const world = (kit) => stage(kit, "world", async () => {
  const w = await tradeCompany(kit, { name: "Voltline Electric - service call (acceptance)" })
  const { q } = kit
  const codes = Object.fromEntries(kit.rows(`select code, id from public.cost_codes where org_id=${q(w.orgId)} and code in ('3270','3280')`).map((row) => [row.code, row.id]))
  // The job budgets labor and material by cost code, so the clock asks the crew which one their hours belong to.
  await kit.as(w.actors.owner, () => app("budgets").createBudget({ project_id: w.jobs.homeowner, status: "approved", lines: [
    { cost_code_id: codes["3270"], description: "Rough electrical labor", amount_cents: 4_000_000 },
    { cost_code_id: codes["3280"], description: "Rough electrical material", amount_cents: 2_000_000 },
  ] }))
  w.codes = codes
  return w
})

const costs = (kit) => stage(kit, "costs", async () => {
  const w = await world(kit)
  const { q } = kit
  for (const key of ["crew", "crewTwo"]) {
    const actor = w.actors[key]
    await kit.as(actor, () => app("time-clock").clockIn({ projectId: w.jobs.homeowner, costCodeId: w.codes["3270"], source: "mobile" }))
    kit.sql(`update public.time_clock_sessions set started_at = now() - interval '${HOURS} hours', work_date = ${q(DAY)} where org_id=${q(w.orgId)} and worker_user_id=${q(actor.userId)} and ended_at is null;`)
    await kit.as(actor, () => app("time-clock").clockOut({}))
  }
  const ids = kit.rows(`select id from public.time_entries where org_id=${q(w.orgId)}`).map((row) => row.id)
  w.approval = await kit.as(w.actors.foreman, () => app("timesheets").approveTimeEntries({ ids }))
  // The office enters the supply-house receipt; the owner approves it (the person who enters a cost does not approve it).
  w.expense = await kit.as(w.actors.officeAdmin, () => app("cost-plus").createProjectExpense({ projectId: w.jobs.homeowner, costCodeId: w.codes["3280"], expenseDate: DAY,
    description: "Supply house receipt - wire, boxes and breakers", vendorNameText: "Treasure Coast Electric Supply", amountCents: 34_000, paymentMethod: "company_card", isBillable: true }))
  await kit.as(w.actors.owner, () => app("cost-plus").approveProjectExpense(w.expense.id))
  return w
})

const ticketed = (kit) => stage(kit, "ticketed", async () => {
  const w = await costs(kit)
  const { q } = kit
  const tickets = app("tm-tickets")
  const open = kit.rows(`select id from public.billable_costs where org_id=${q(w.orgId)} and project_id=${q(w.jobs.homeowner)} and status='open'`).map((row) => row.id)
  w.ticket = await kit.as(w.actors.officeAdmin, () => tickets.createTmTicket({ projectId: w.jobs.homeowner, workDate: DAY, billableCostIds: open }))
  w.beforeSigning = await refusal(() => kit.as(w.actors.officeAdmin, () => tickets.generateInvoiceFromTmTicket(w.ticket.id)))
  w.link = await kit.as(w.actors.officeAdmin, () => tickets.createTmTicketSignatureLink(w.ticket.id))
  w.page = await tickets.getTmTicketBySignatureToken(w.link.token)
  return w
})

const signed = (kit) => stage(kit, "signed", async () => {
  const w = await ticketed(kit)
  const tickets = app("tm-tickets")
  // What the page's form action sends: the typed name and acceptance, with the signer's address and agent.
  w.signed = await tickets.signTmTicketByToken({ token: w.link.token, signerName: "Henry Homeowner", signerEmail: "henry@example.test", signerIp: "203.0.113.9",
    signatureData: { typed_signature: "Henry Homeowner", accepted_at: new Date().toISOString(), user_agent: "acceptance" } })
  w.pageAfterSigning = await tickets.getTmTicketBySignatureToken(w.link.token)
  w.signAgain = await refusal(() => tickets.signTmTicketByToken({ token: w.link.token, signerName: "Henry Homeowner" }))
  return w
})

const invoiced = (kit) => stage(kit, "invoiced", async () => {
  const w = await signed(kit)
  const tickets = app("tm-tickets")
  w.generated = await kit.as(w.actors.officeAdmin, () => tickets.generateInvoiceFromTmTicket(w.ticket.id))
  w.generatedAgain = await refusal(() => kit.as(w.actors.officeAdmin, () => tickets.generateInvoiceFromTmTicket(w.ticket.id)))
  return w
})

const issued = (kit) => stage(kit, "issued", async () => {
  const w = await invoiced(kit)
  await kit.as(w.actors.officeAdmin, () => app("invoices").issueInvoice({ invoiceId: w.generated.invoiceId, recipients: ["henry@example.test"] }))
  return w
})

async function crewHoursAndSupplyReceiptBecomeBillableCosts(kit, spec, check) {
  const w = await costs(kit)
  const { q } = kit
  const entries = kit.rows(`select e.worker_name worker, e.hours::float8 hours, c.code, e.status, e.cost_cents from public.time_entries e join public.cost_codes c on c.id=e.cost_code_id
    where e.org_id=${q(w.orgId)} and e.project_id=${q(w.jobs.homeowner)} order by e.worker_name`)
  const [expense] = kit.rows(`select x.amount_cents, x.status, c.code, x.is_billable from public.project_expenses x join public.cost_codes c on c.id=x.cost_code_id where x.org_id=${q(w.orgId)} and x.project_id=${q(w.jobs.homeowner)}`)
  const billable = kit.rows(`select b.source_type, b.description, b.status, b.cost_cents, b.markup_cents, b.billable_cents, c.code from public.billable_costs b join public.cost_codes c on c.id=b.cost_code_id
    where b.org_id=${q(w.orgId)} and b.project_id=${q(w.jobs.homeowner)} order by b.source_type, b.description`)
  check.equal("two crew members each clock six hours on the job's labor code and the foreman approves them; the $340 supply receipt is entered against the material code and approved: the approved labor and the receipt are open billable costs, labor at the job's bill rate, the receipt at cost", spec.expected, {
    approvalRefused: w.approval.failed,
    entries: entries.map((row) => ({ worker: row.worker, hours: row.hours, costCode: row.code, status: row.status, costCents: row.cost_cents })),
    expense: { amountCents: expense.amount_cents, status: expense.status, costCode: expense.code, billable: expense.is_billable },
    billableCosts: billable.map((row) => ({ description: row.description, costCode: row.code, status: row.status, costCents: row.cost_cents, markupCents: row.markup_cents, billableCents: row.billable_cents })),
    totals: { costCents: billable.reduce((sum, row) => sum + row.cost_cents, 0), billableCents: billable.reduce((sum, row) => sum + row.billable_cents, 0) },
  })
  return { orgId: w.orgId }
}

async function tmTicketIsSignedOnItsLink(kit, spec, check) {
  const w = await signed(kit)
  const { q } = kit
  const [row] = kit.rows(`select status, client_signer_name, client_signer_email, client_signed_at is not null signed, signature_token_hash is null token_spent from public.tm_tickets where id=${q(w.ticket.id)}`)
  const fixedPrice = await refusal(() => kit.as(w.actors.officeAdmin, () => app("tm-tickets").createTmTicket({ projectId: w.jobs.gc, workDate: DAY })))
  check.equal("the office makes a ticket of the day's three costs; it cannot be invoiced unsigned; the link's page shows the ticket and its items; the homeowner signs once and the link is spent; a fixed-price job cannot have a T&M ticket", spec.expected, {
    ticket: { number: w.ticket.ticket_number, status: w.ticket.status, itemCount: w.ticket.items.length, costCents: w.ticket.totals.cost_cents, billableCents: w.ticket.totals.billable_cents },
    invoicingBeforeSigning: w.beforeSigning,
    tokenPage: { status: w.page?.status, items: (w.page?.items ?? []).map((item) => item.description).sort(), billableCents: w.page?.totals.billable_cents },
    signed: { status: row.status, signerName: row.client_signer_name, signerEmail: row.client_signer_email, hasSignedAt: row.signed },
    linkAfterSigning: { tokenPage: w.pageAfterSigning, spent: row.token_spent, signingAgain: w.signAgain },
    fixedPriceJob: fixedPrice,
  })
  return { orgId: w.orgId, ticketId: w.ticket.id }
}

async function invoiceIsGeneratedFromTheSignedTicket(kit, spec, check) {
  const w = await issued(kit)
  const { q } = kit
  const [invoice] = kit.rows(`select id, status, total_cents, subtotal_cents, tax_cents, balance_due_cents, metadata->>'tm_ticket_number' ticket_number from public.invoices where org_id=${q(w.orgId)} and id=${q(w.generated.invoiceId)}`)
  const lines = kit.rows(`select description, unit_price_cents from public.invoice_lines where invoice_id=${q(w.generated.invoiceId)} order by sort_order`)
  const [ticket] = kit.rows(`select status, invoice_id from public.tm_tickets where id=${q(w.ticket.id)}`)
  const costs = kit.rows(`select distinct status from public.billable_costs where org_id=${q(w.orgId)} and project_id=${q(w.jobs.homeowner)}`)
  check.equal("the signed ticket's three costs become one invoice at the ticket's billable total (labor at the bill rate, the receipt at cost, no tax), carrying the ticket's number; the ticket is billed and linked, its costs are billed, a second invoice is refused, and the office issues the invoice", spec.expected, {
    invoice: { status: invoice.status, subtotalCents: invoice.subtotal_cents, taxCents: invoice.tax_cents, totalCents: invoice.total_cents, ticketNumber: invoice.ticket_number },
    lines: lines.map((line) => ({ description: line.description, amountCents: line.unit_price_cents })),
    ticket: { status: ticket.status, linkedToTheInvoice: ticket.invoice_id === invoice.id },
    costStatuses: costs.map((row) => row.status),
    secondInvoice: w.generatedAgain,
  })
  return { orgId: w.orgId, invoiceId: invoice.id }
}

/** The settlement a card payment sends, shaped as the Stripe webhook sends it to the service that records it. */
async function cardSettlementPaysTheInvoice(kit, spec, check) {
  const w = await issued(kit)
  const { q } = kit
  const providerPaymentId = `pi_acceptance_${w.generated.invoiceId.slice(0, 8)}`
  const settle = () => app("payments").recordPayment({ invoice_id: w.generated.invoiceId, amount_cents: 124_000, currency: "usd", method: "card", provider: "stripe",
    provider_payment_id: providerPaymentId, status: "succeeded", fee_cents: 3_626, idempotency_key: providerPaymentId, metadata: {} }, w.orgId)
  const first = await refusal(settle)
  const replay = first === "allowed" ? await refusal(settle) : "not attempted"
  const [invoice] = kit.rows(`select status, balance_due_cents from public.invoices where id=${q(w.generated.invoiceId)}`)
  const payments = kit.rows(`select method, provider, status, amount_cents, fee_cents, net_cents from public.payments where org_id=${q(w.orgId)} and invoice_id=${q(w.generated.invoiceId)}`)
  check.equal("the card settlement of the full $1,240.00 (the provider's fee 2.9% + 30 cents) is recorded against the issued invoice: it is paid in full with a card payment net of the fee, and a replay of the same settlement records nothing more", spec.expected, {
    settlement: first, replay,
    invoice: { status: invoice.status, balanceDueCents: invoice.balance_due_cents },
    payments: payments.map((row) => ({ method: row.method, provider: row.provider, status: row.status, amountCents: row.amount_cents, feeCents: row.fee_cents, netCents: row.net_cents })),
  })
  return { orgId: w.orgId, invoiceId: w.generated.invoiceId }
}

async function laborAndMaterialPostToTheJob(kit, spec, check) {
  const w = await costs(kit)
  const { q } = kit
  const posted = kit.rows(`select j.source_type, j.status, j.cost_cents, c.code from public.job_cost_entries j join public.cost_codes c on c.id=j.cost_code_id
    where j.org_id=${q(w.orgId)} and j.project_id=${q(w.jobs.homeowner)} order by c.code, j.cost_cents`)
  const actuals = await kit.as(w.actors.owner, () => app("budgets").getBudgetWithActuals(w.jobs.homeowner))
  check.equal("the two approved labor entries and the approved receipt post to the Palm Court job at cost, labor to the labor code and the receipt to the material code, and the job's budget reads them as its actuals", spec.expected, {
    jobCost: posted.map((row) => ({ costCode: row.code, source: row.source_type, status: row.status, costCents: row.cost_cents })),
    actuals: { totalActualCents: actuals.summary.total_actual_cents, totalBudgetCents: actuals.summary.total_budget_cents },
  })
  return { orgId: w.orgId }
}

module.exports = {
  id: "TRADE-TM-01",
  subcases: {
    "crew-hours-and-supply-receipt-become-billable-costs": crewHoursAndSupplyReceiptBecomeBillableCosts,
    "labor-and-material-post-to-the-job": laborAndMaterialPostToTheJob,
    "tm-ticket-is-signed-on-its-link": tmTicketIsSignedOnItsLink,
    "invoice-is-generated-from-the-signed-ticket": invoiceIsGeneratedFromTheSignedTicket,
    "card-settlement-pays-the-invoice": cardSettlementPaysTheInvoice,
  },
}
