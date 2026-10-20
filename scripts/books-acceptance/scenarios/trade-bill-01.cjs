// TRADE-BILL-01 — an SOV job for a GC with retainage (TR02-03). The Arc Trade company from
// trade-seed.cjs (its own organization for this scenario) wires Harbor General's tenant electrical
// job: $180,000, billed by schedule of values with 10% retainage held, the customer (the GC)
// certifying every application. Pay application 1 goes out with a conditional progress waiver, the GC
// certifies it on its portal, a partial ACH payment comes in, a change order is approved, the final
// application bills the rest, and the retainage is released with an unconditional final waiver.
//
//   pay-application-1-is-submitted-with-a-conditional-waiver  the application's nine G702 figures,
//                                                             the retainage withheld from its invoice,
//                                                             the waiver and the email to the GC
//   gc-certifies-on-the-portal-and-the-invoice-issues         the portal shows it awaiting a
//                                                             certificate; certifying issues the
//                                                             invoice; only a certifier can certify
//   partial-ach-payment-is-recorded                           a part payment leaves the balance and
//                                                             keeps the conditional waiver pending
//   retainage-is-held-on-the-job                              the retainage rows and the SOV carry
//                                                             what the GC holds
//   billing-book-shows-held-retainage-once                    the billing book's receivable view
//   change-order-is-approved-between-pay-applications         the approved change order adds an SOV
//                                                             line and the contract sum, and rewrites
//                                                             nothing already certified
//   final-pay-application-bills-the-rest-with-retainage       the remaining work and the change order
//                                                             bill at 100% with retainage withheld
//   ach-payment-clears-both-invoices-and-releases-the-waiver  full payment of an invoice releases its
//                                                             conditional waiver
//   retainage-release-with-an-unconditional-final-waiver      the release is its own application, its
//                                                             invoice carries the final waiver, and
//                                                             paying it ends the job's retainage
const { randomUUID } = require("node:crypto")
const { tradeCompany } = require("../trade-seed.cjs")
const { app } = require("./shared.cjs")

const A = (path) => require(`../../../${path}`)

const STAGES = new WeakMap()
function stage(kit, name, build) {
  if (!STAGES.has(kit)) STAGES.set(kit, new Map())
  const stages = STAGES.get(kit)
  if (!stages.has(name)) stages.set(name, build())
  return stages.get(name)
}
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 140)}` } }

// The schedule of values: four lines that foot to the $180,000 contract.
const SOV = [
  ["Rough-in and distribution", 8_000_000],
  ["Fixtures and devices", 5_000_000],
  ["Panels and switchgear", 3_500_000],
  ["Trim-out, testing and commissioning", 1_500_000],
]
// Work completed to the end of October on pay application 1, by SOV line.
const FIRST = [4_000_000, 1_000_000, 1_400_000, 0]
const CHANGE_ORDER = { title: "Add EV charging circuits, level 2", cents: 2_000_000 }

/**
 * The two outside services a pay application touches have no counterpart on the acceptance stack, so the
 * scenario stands in for them for the length of a subcase: the mail provider (the message is captured, with its
 * recipients and link, instead of sent) and Next's request-scoped cache invalidation, which the portal's server
 * action calls after it has certified and which has no request outside a server.
 */
const MAIL = new WeakMap()
function withStandIns(run) {
  return async (kit, spec, check) => {
    const mailer = A("lib/services/mailer")
    const realSend = mailer.sendEmail
    const nextCache = require(require.resolve("next/cache", { paths: [process.cwd()] }))
    const realRevalidate = nextCache.revalidatePath
    if (!MAIL.has(kit)) MAIL.set(kit, [])
    mailer.sendEmail = async (payload) => { MAIL.get(kit).push(payload); return true }
    Object.defineProperty(nextCache, "revalidatePath", { value: () => {}, configurable: true, writable: true })
    try {
      return await run(kit, spec, check)
    } finally {
      mailer.sendEmail = realSend
      Object.defineProperty(nextCache, "revalidatePath", { value: realRevalidate, configurable: true, writable: true })
    }
  }
}

const world = (kit) => stage(kit, "world", async () => {
  const w = await tradeCompany(kit, { name: "Voltline Electric - Harbor Tower (acceptance)" })
  w.sov = await kit.as(w.actors.officeAdmin, () => app("prime-sov").upsertPrimeSovLines(w.jobs.gc, { lines: SOV.map(([description, cents]) => ({ description, scheduled_value_cents: cents })) }))
  w.portalPermissions = { can_view_invoices: true, can_certify_pay_applications: true, can_view_documents: true }
  return w
})

/** One application: a draft with the amounts entered by SOV line (in line order), then submitted. */
async function submit(kit, w, amounts) {
  const payApps = app("pay-applications")
  const draft = await kit.as(w.actors.officeAdmin, () => payApps.createPayApplication(w.jobs.gc, { period_start: "2026-10-01", period_end: "2026-10-31" }))
  const lines = [...draft.lines].sort((a, b) => a.line_number - b.line_number)
  await kit.as(w.actors.officeAdmin, () => payApps.updatePayApplicationLines(draft.application.id, { entries: lines.map((line, index) => ({ prime_sov_line_id: line.prime_sov_line_id, this_period_cents: amounts[index] })) }))
  return kit.as(w.actors.officeAdmin, () => payApps.submitPayApplication(draft.application.id))
}

/** The app emails the GC a link to certify; the token in it is the GC's portal access. */
async function sendToTheGc(kit, w, payApplicationId) {
  const before = MAIL.get(kit).length
  const detail = await kit.as(w.actors.officeAdmin, () => app("pay-applications").sendPayApplication(payApplicationId, {}))
  const message = MAIL.get(kit).slice(before).find((mail) => /pay-applications/.test(mail.html))
  const link = /\/p\/([0-9a-f]+)\/pay-applications\/([0-9a-f-]+)/.exec(/href="([^"]*pay-applications[^"]*)"/.exec(message.html)?.[1] ?? "")
  return { detail, recipients: message.to, token: link?.[1], linkedApplicationId: link?.[2] }
}

/** The portal's certificate action, called as the portal page's form calls it. */
const certify = (token, payApplicationId, signerName = "Gina Harbor") =>
  A("app/p/[token]/pay-applications/actions.ts").certifyPayApplicationPortalAction(token, payApplicationId, { signerName, signatureText: signerName, consentAccepted: true, note: null })

const figures = (a) => ({
  originalContractSumCents: a.original_contract_sum_cents, changeOrderSumCents: a.change_order_sum_cents, contractSumToDateCents: a.contract_sum_to_date_cents,
  totalCompletedAndStoredCents: a.total_completed_stored_cents, retainageCents: a.retainage_cents, totalEarnedLessRetainageCents: a.total_earned_less_retainage_cents,
  previousCertificatesCents: a.previous_certificates_cents, currentPaymentDueCents: a.current_payment_due_cents, balanceToFinishCents: a.balance_to_finish_cents,
})

const first = (kit) => stage(kit, "first", async () => {
  const w = await world(kit)
  const detail = await submit(kit, w, FIRST)
  w.app1 = { id: detail.application.id, invoiceId: detail.application.invoice_id, submitted: detail }
  w.waiver1 = await kit.as(w.actors.officeAdmin, () => app("invoice-lien-waivers").createInvoiceLienWaiver({ invoice_id: w.app1.invoiceId, waiver_type: "conditional_progress" }))
  w.send1 = await sendToTheGc(kit, w, w.app1.id)
  return w
})

const certified1 = (kit) => stage(kit, "certified1", async () => {
  const w = await first(kit)
  const load = A("app/p/[token]/load-portal.ts")
  w.portalBefore = (await load.loadClientPortalPayApplicationsPage(w.send1.token)).applications
  // A link that may view but not certify (the GC's accounting clerk).
  const viewer = await kit.as(w.actors.owner, () => app("portal-access").createPortalAccessToken({ projectId: w.jobs.gc, portalType: "client", contactId: w.customers.gcContactId, permissions: { can_view_invoices: true, can_certify_pay_applications: false }, orgId: w.orgId }))
  w.viewerCertify = await certify(viewer.token, w.app1.id)
  w.certify1 = await certify(w.send1.token, w.app1.id)
  w.certifyAgain = await certify(w.send1.token, w.app1.id)
  w.portalAfter = (await load.loadClientPortalPayApplicationsPage(w.send1.token)).applications
  return w
})

const ach = (kit, w, allocations, reference) => kit.as(w.actors.officeAdmin, () => app("payments").recordMultiInvoicePayment({
  received_at: new Date().toISOString(), method: "ach", reference, idempotency_key: randomUUID(), allocations: allocations.map(([invoice_id, amount_cents]) => ({ invoice_id, amount_cents })),
}))

const part = (kit) => stage(kit, "part", async () => {
  const w = await certified1(kit)
  w.partial = await ach(kit, w, [[w.app1.invoiceId, 3_000_000]], "ACH-HARBOR-0001")
  return w
})

const changed = (kit) => stage(kit, "changed", async () => {
  const w = await part(kit)
  const orders = app("change-orders")
  const order = await kit.as(w.actors.officeAdmin, () => orders.createChangeOrder({ input: { project_id: w.jobs.gc, title: CHANGE_ORDER.title, summary: "Owner added level 2 charging circuits to the tenant scope", tax_rate: 0, markup_percent: 0, markup_mode: "percent", requires_signature: false,
    lines: [{ description: "Level 2 EV charging circuits", quantity: 1, unit_cost: CHANGE_ORDER.cents / 100, taxable: false }] } }))
  await kit.as(w.actors.owner, () => orders.approveChangeOrder({ changeOrderId: order.id, approval: { signerName: "Gina Harbor", note: "Approved by email" } }))
  w.changeOrderId = order.id
  return w
})

// The remaining work on every line to 100%: the four original lines and the change order's.
const REST = [4_000_000, 4_000_000, 2_100_000, 1_500_000, CHANGE_ORDER.cents]

const final = (kit) => stage(kit, "final", async () => {
  const w = await changed(kit)
  const detail = await submit(kit, w, REST)
  w.app2 = { id: detail.application.id, invoiceId: detail.application.invoice_id, submitted: detail }
  w.send2 = await sendToTheGc(kit, w, w.app2.id)
  w.certify2 = await certify(w.send2.token, w.app2.id)
  return w
})

const paid = (kit) => stage(kit, "paid", async () => {
  const w = await final(kit)
  w.clearing = await ach(kit, w, [[w.app1.invoiceId, 2_760_000], [w.app2.invoiceId, 12_240_000]], "ACH-HARBOR-0002")
  return w
})

const released = (kit) => stage(kit, "released", async () => {
  const w = await paid(kit)
  const detail = await kit.as(w.actors.officeAdmin, () => app("pay-applications").releasePrimeRetainage(w.jobs.gc, { full: true }))
  w.app3 = { id: detail.application.id, invoiceId: detail.application.invoice_id, detail }
  w.finalWaiver = await kit.as(w.actors.officeAdmin, () => app("retainage").createRetainageReleaseWaiver(w.jobs.gc, w.app3.invoiceId))
  w.send3 = await sendToTheGc(kit, w, w.app3.id)
  w.certify3 = await certify(w.send3.token, w.app3.id)
  w.releasePaid = await ach(kit, w, [[w.app3.invoiceId, 2_000_000]], "ACH-HARBOR-0003")
  return w
})

const invoiceOf = (kit, id) => kit.rows(`select status, total_cents, balance_due_cents from public.invoices where id=${kit.q(id)}`)[0]
const invoiceLines = (kit, id) => kit.rows(`select description, unit_price_cents from public.invoice_lines where invoice_id=${kit.q(id)}`).map((row) => [row.description, row.unit_price_cents]).sort((a, b) => a[0].localeCompare(b[0]))
const waiverOf = (kit, id) => kit.rows(`select waiver_type, status, amount_cents, metadata->'signature'->>'signer_name' signer from public.invoice_lien_waivers where invoice_id=${kit.q(id)} and status <> 'void' order by created_at`)
const retainageRows = (kit, w) => kit.rows(`select status, sum(amount_cents)::int cents from public.retainage where org_id=${kit.q(w.orgId)} and project_id=${kit.q(w.jobs.gc)} group by status order by status`)
const sovSummary = (kit, w) => kit.as(w.actors.officeAdmin, () => app("prime-sov").listPrimeSovLines(w.jobs.gc)).then((state) => state.summary)

async function pay1IsSubmittedWithAConditionalWaiver(kit, spec, check) {
  const w = await first(kit)
  const invoice = invoiceOf(kit, w.app1.invoiceId)
  const application = w.app1.submitted.application
  const sent = w.send1.detail.application
  check.equal("the SOV foots to the $180,000 contract; application 1 bills $64,000 of work with 10% retainage, nets $57,600 on its invoice as work lines less a retainage line (still a draft until certified), carries a conditional progress waiver signed by the office admin for the net, and is emailed to the GC with a link to certify it", spec.expected, {
    sov: { contractSumCents: w.sov.summary.contract_sum_cents, scheduledTotalCents: w.sov.summary.scheduled_total_cents, lines: w.sov.lines.map((line) => [line.description, line.scheduled_value_cents]) },
    application: { number: application.application_number, ...figures(application) },
    invoice: { status: invoice.status, totalCents: invoice.total_cents, lines: invoiceLines(kit, w.app1.invoiceId) },
    retainageWithheld: retainageRows(kit, w),
    waiver: waiverOf(kit, w.app1.invoiceId),
    sentToTheGc: { stage: sent.stage, recipients: w.send1.recipients, linkIsThisApplicationsCertificatePage: w.send1.linkedApplicationId === w.app1.id },
  })
  return { orgId: w.orgId, payApplicationId: w.app1.id }
}

async function gcCertifiesOnThePortalAndTheInvoiceIssues(kit, spec, check) {
  const w = await certified1(kit)
  const row = (list) => list.map((a) => ({ number: a.application_number, stage: a.stage, awaitingCertificate: a.awaiting_certificate, currentPaymentDueCents: a.current_payment_due_cents, certifiedBy: a.certification?.signer_name ?? null, certifiedCents: a.certification?.certified_amount_cents ?? null, invoiceStatus: a.invoice_status }))
  const invoice = invoiceOf(kit, w.app1.invoiceId)
  check.equal("on its portal link the GC sees application 1 awaiting its certificate for $57,600; a link that cannot certify is refused; Gina Harbor certifies it, which issues the invoice at $57,600 with the certificate on the application; a second certificate is refused", spec.expected, {
    portalBefore: row(w.portalBefore),
    linkWithoutCertifyPermission: { success: w.viewerCertify.success, error: w.viewerCertify.error ?? null },
    certificate: { success: w.certify1.success, invoiceIsTheApplicationsInvoice: w.certify1.data?.invoiceId === w.app1.invoiceId },
    portalAfter: row(w.portalAfter),
    invoice: { status: invoice.status, totalCents: invoice.total_cents, balanceDueCents: invoice.balance_due_cents },
    certifyingAgain: { success: w.certifyAgain.success, error: w.certifyAgain.error ?? null },
  })
  return { orgId: w.orgId, payApplicationId: w.app1.id }
}

async function partialAchPaymentIsRecorded(kit, spec, check) {
  const w = await part(kit)
  const payments = kit.rows(`select method, status, amount_cents, reference from public.payments where org_id=${kit.q(w.orgId)} and invoice_id=${kit.q(w.app1.invoiceId)}`)
  const invoice = invoiceOf(kit, w.app1.invoiceId)
  const [application] = (await A("app/p/[token]/load-portal.ts").loadClientPortalPayApplicationsPage(w.send1.token)).applications
  check.equal("a $30,000 ACH payment is received against the $57,600 invoice: one ACH payment is recorded, the invoice is partially paid with $27,600 due, the GC's portal shows the same balance, and the conditional waiver stays pending until the invoice is paid in full", spec.expected, {
    payments: payments.map((row) => ({ method: row.method, status: row.status, amountCents: row.amount_cents, reference: row.reference })),
    invoice: { status: invoice.status, balanceDueCents: invoice.balance_due_cents },
    portalBalanceCents: application.invoice_balance_due_cents,
    waiver: waiverOf(kit, w.app1.invoiceId).map((waiver) => ({ type: waiver.waiver_type, status: waiver.status })),
  })
  return { orgId: w.orgId }
}

async function retainageIsHeldOnTheJob(kit, spec, check) {
  const w = await part(kit)
  const summary = await sovSummary(kit, w)
  check.equal("10% of the $64,000 billed, $6,400, is held: the retainage record sits on the application's invoice and the SOV reports $6,400 held and none released against $64,000 billed", spec.expected, {
    retainageRecords: retainageRows(kit, w),
    recordsOnTheApplicationsInvoice: Number(kit.rows(`select count(*) n from public.retainage where org_id=${kit.q(w.orgId)} and invoice_id=${kit.q(w.app1.invoiceId)} and status='held'`)[0].n),
    sov: { billedCents: summary.billed_total_cents, heldCents: summary.retainage_held_cents, releasedCents: summary.retainage_released_cents },
  })
  return { orgId: w.orgId }
}

async function billingBookShowsHeldRetainageOnce(kit, spec, check) {
  const w = await part(kit)
  // The billing page asks for the SOV's retainage on a job that bills by schedule of values.
  const summary = await kit.as(w.actors.officeAdmin, () => app("billing-book").getProjectBillingSummary(w.jobs.gc, { includeSovRetainage: true }))
  check.equal("the billing book for the job reports the retainage the GC holds, $6,400, once, beside the $27,600 still owed on the invoice and the $30,000 collected", spec.expected, {
    retainageHeldCents: summary.retainageHeldCents, outstandingCents: summary.outstandingCents, collectedCents: summary.collectedCents,
  })
  return { orgId: w.orgId }
}

async function changeOrderIsApprovedBetweenPayApplications(kit, spec, check) {
  const w = await changed(kit)
  const [order] = kit.rows(`select status, lifecycle, total_cents from public.change_orders where id=${kit.q(w.changeOrderId)}`)
  const state = await kit.as(w.actors.officeAdmin, () => app("prime-sov").listPrimeSovLines(w.jobs.gc))
  const [application] = (await A("app/p/[token]/load-portal.ts").loadClientPortalPayApplicationsPage(w.send1.token)).applications
  check.equal("the $20,000 change order is approved after application 1 was certified and part-paid: the SOV gains one line for it and the contract sum to date becomes $200,000, still footing; application 1's figures, its invoice and the retainage held do not move", spec.expected, {
    changeOrder: { status: order.status, lifecycle: order.lifecycle, totalCents: order.total_cents },
    sov: { contractSumCents: state.summary.contract_sum_cents, scheduledTotalCents: state.summary.scheduled_total_cents, varianceCents: state.summary.variance_cents,
      lines: state.lines.map((line) => [line.description, line.scheduled_value_cents, line.previous_billed_cents]), retainageHeldCents: state.summary.retainage_held_cents },
    applicationOne: { ...figures(application), invoiceBalanceCents: application.invoice_balance_due_cents },
  })
  return { orgId: w.orgId, changeOrderId: w.changeOrderId }
}

async function finalPayApplicationBillsTheRestWithRetainage(kit, spec, check) {
  const w = await final(kit)
  const application = w.app2.submitted.application
  const invoice = invoiceOf(kit, w.app2.invoiceId)
  const summary = await sovSummary(kit, w)
  check.equal("application 2 bills the remaining $136,000 of work, the change order included, with $13,600 more retainage: its G702 shows $200,000 to date, $20,000 held in all, $122,400 payment due after application 1's $57,600, and the GC's certificate issues its invoice at $122,400", spec.expected, {
    application: { number: application.application_number, ...figures(application) },
    emailedToTheGc: { recipients: w.send2.recipients, linkIsThisApplicationsCertificatePage: w.send2.linkedApplicationId === w.app2.id },
    certificate: { success: w.certify2.success },
    invoice: { status: invoice.status, totalCents: invoice.total_cents, lines: invoiceLines(kit, w.app2.invoiceId) },
    retainageWithheld: retainageRows(kit, w),
    sov: { billedCents: summary.billed_total_cents, retainageHeldCents: summary.retainage_held_cents },
  })
  return { orgId: w.orgId, payApplicationId: w.app2.id }
}

async function achPaymentClearsBothInvoicesAndReleasesTheWaiver(kit, spec, check) {
  const w = await paid(kit)
  const payments = kit.rows(`select p.method, p.amount_cents, i.id invoice_id from public.payments p join public.invoices i on i.id=p.invoice_id where p.org_id=${kit.q(w.orgId)}`)
  check.equal("a $150,000 ACH payment is allocated $27,600 to application 1's invoice and $122,400 to application 2's (recorded as one payment per invoice, beside the earlier $30,000): both invoices are paid in full with nothing due, and application 1's conditional progress waiver is released by its invoice being paid", spec.expected, {
    invoices: [invoiceOf(kit, w.app1.invoiceId), invoiceOf(kit, w.app2.invoiceId)].map((invoice) => ({ status: invoice.status, totalCents: invoice.total_cents, balanceDueCents: invoice.balance_due_cents })),
    achPayments: payments.map((row) => ({ method: row.method, amountCents: row.amount_cents, onApplication: row.invoice_id === w.app1.invoiceId ? 1 : 2 })).sort((a, b) => a.onApplication - b.onApplication || a.amountCents - b.amountCents),
    conditionalWaiver: waiverOf(kit, w.app1.invoiceId).map((waiver) => ({ type: waiver.waiver_type, status: waiver.status })),
  })
  return { orgId: w.orgId }
}

async function retainageReleaseWithAnUnconditionalFinalWaiver(kit, spec, check) {
  const w = await released(kit)
  const application = (await A("app/p/[token]/load-portal.ts").loadClientPortalPayApplicationsPage(w.send3.token)).applications.find((a) => a.id === w.app3.id)
  const summary = await sovSummary(kit, w)
  const billing = await kit.as(w.actors.officeAdmin, () => app("billing-book").getProjectBillingSummary(w.jobs.gc, { includeSovRetainage: true }))
  const again = await refusal(() => kit.as(w.actors.officeAdmin, () => app("pay-applications").releasePrimeRetainage(w.jobs.gc, { full: true })))
  check.equal("releasing all $20,000 of retainage is application 3: a release application and invoice for $20,000 that carries an unconditional final waiver, certified by the GC and paid by ACH; the invoice is paid, the final waiver is released, the SOV shows $20,000 held and $20,000 released, the billing book holds no retainage and no balance, and nothing remains to release", spec.expected, {
    application: { number: application.application_number, isRetainageRelease: application.is_retainage_release, currentPaymentDueCents: application.current_payment_due_cents, stage: application.stage },
    invoice: { status: invoiceOf(kit, w.app3.invoiceId).status, totalCents: invoiceOf(kit, w.app3.invoiceId).total_cents, balanceDueCents: invoiceOf(kit, w.app3.invoiceId).balance_due_cents },
    finalWaiver: waiverOf(kit, w.app3.invoiceId).map((waiver) => ({ type: waiver.waiver_type, status: waiver.status, amountCents: waiver.amount_cents })),
    sov: { heldCents: summary.retainage_held_cents, releasedCents: summary.retainage_released_cents },
    retainageRecords: retainageRows(kit, w),
    billingBook: { retainageHeldCents: billing.retainageHeldCents, outstandingCents: billing.outstandingCents },
    releasingAgain: again,
  })
  return { orgId: w.orgId, payApplicationId: w.app3.id }
}

module.exports = {
  id: "TRADE-BILL-01",
  subcases: {
    "pay-application-1-is-submitted-with-a-conditional-waiver": withStandIns(pay1IsSubmittedWithAConditionalWaiver),
    "gc-certifies-on-the-portal-and-the-invoice-issues": withStandIns(gcCertifiesOnThePortalAndTheInvoiceIssues),
    "partial-ach-payment-is-recorded": withStandIns(partialAchPaymentIsRecorded),
    "retainage-is-held-on-the-job": withStandIns(retainageIsHeldOnTheJob),
    "billing-book-shows-held-retainage-once": withStandIns(billingBookShowsHeldRetainageOnce),
    "change-order-is-approved-between-pay-applications": withStandIns(changeOrderIsApprovedBetweenPayApplications),
    "final-pay-application-bills-the-rest-with-retainage": withStandIns(finalPayApplicationBillsTheRestWithRetainage),
    "ach-payment-clears-both-invoices-and-releases-the-waiver": withStandIns(achPaymentClearsBothInvoicesAndReleasesTheWaiver),
    "retainage-release-with-an-unconditional-final-waiver": withStandIns(retainageReleaseWithAnUnconditionalFinalWaiver),
  },
}
