// TRADE-QUOTE-01 — invite to job (TR04-01 .. TR04-03). A builder organization on Arc invites the seeded
// electrical company to price a job; the trade owner claims the invitation, tracks it as an opportunity with
// the builder's due date, builds a quote from labor, material, equipment and markup, sends it on the /e review
// link, logs a follow-up, the customer accepts on the portal, and the office starts the job, which carries the
// accepted price, the customer and the billing the office confirmed. The trade's services are the ones the pages
// call (lib/services/trade-quotes.ts, the estimate portal); the builder's side is its own bid services.
//
//   invitation-becomes-an-itb-with-a-due-date        the claimed invitation lists as untracked, tracks once into an opportunity
//                                                    that carries the builder, the project and the package's due date
//   an-invited-opportunity-can-be-sent-a-quote       a tracked invitation has no customer email; the office sets one on the opportunity and the quote can go out
//   quote-from-labor-material-and-markup             the quote's lines, sections, optional add-on, tax and total
//   quote-sent-on-the-portal-and-follow-up-logged    send on /e (no mail on the stack), the trail, the follow-up and its stage
//   customer-accepts-on-the-portal                   the customer signs on the review link; the price they accepted
//   accepted-quote-starts-a-job-with-its-terms       the job carries contract amount, customer and billing basis; starting twice is one job
const { tradeCompany } = require("../trade-seed.cjs")
const { app } = require("./shared.cjs")
const { asTrade, claimInvitation, builderOrg, installRequestScope } = require("./trade-network.cjs")

const A = (path) => require(`../../../${path}`)
const DAY = 86_400_000
const dayAt = (offset, time = "17:00:00.000Z") => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10) + `T${time}`
const day = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return `refused: ${String(error?.message ?? error).slice(0, 160)}` } }

const QUOTE_LINES = [
  { kind: "labor", section: "Service and rough-in", description: "Rough-in labor", quantity: 40, unit: "hr", unit_price_cents: 9_500, markup_percent: 0 },
  { kind: "material", section: "Service and rough-in", description: "200A main panel", quantity: 1, unit: "ea", unit_price_cents: 185_000, markup_percent: 20 },
  { kind: "material", section: "Service and rough-in", description: "Wire, conduit and boxes", quantity: 1, unit: "lot", unit_price_cents: 96_000, markup_percent: 15 },
  { kind: "labor", section: "Finish", description: "Trim-out labor", quantity: 24, unit: "hr", unit_price_cents: 9_500, markup_percent: 0 },
  { kind: "equipment", section: "Finish", description: "Lift rental", quantity: 2, unit: "day", unit_price_cents: 22_500, markup_percent: 10 },
  { kind: "material", section: "Add-ons", description: "EV charger circuit", quantity: 1, unit: "ea", unit_price_cents: 150_000, markup_percent: 10, optional: true },
]
const TAX_RATE = 7

const WORLDS = new WeakMap()
/** The builder, its invitation, and the stages of the flow, each built once on the one before it. */
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, (async () => {
    installRequestScope()
    if (process.env.RESEND_API_KEY) throw Error("Acceptance scenarios never send email; unset RESEND_API_KEY")
    const t = await tradeCompany(kit)
    const owner = t.actors.owner
    const builder = await builderOrg(kit, { name: "TRADE-QUOTE-01 builder", trade: { name: t.name, owner } })
    const due = dayAt(3)
    const pkg = await kit.as(builder.owner, () => app("bids").createBidPackage({ input: { project_id: builder.projectId, title: "Electrical rough-in and trim", trade: "Electrical", due_at: due } }))
    const invite = await kit.as(builder.owner, () => app("bids").createBidInvite({ input: { bid_package_id: pkg.id, company_id: builder.companyId, invite_email: owner.email, status: "sent" } }))
    const link = await kit.as(builder.owner, () => app("bids").generateBidInviteLink(invite.id))
    return { t, owner, builder, due, pkg, invite, link, stages: {} }
  })())
  return WORLDS.get(kit)
}

/** Runs a stage once, after the stage it builds on. */
function stage(kit, name, build) {
  return world(kit).then((w) => (w.stages[name] ??= build(w)))
}

const trade = (kit, w, work) => asTrade(kit, w.owner, work)
const iso = (value) => (value ? new Date(value).toISOString() : null)
const moveOf = (move) => ({ stage: move.stage, label: move.label, sentence: move.sentence, action: move.action, tone: move.tone, valueCents: move.valueCents })
const opportunityOf = async (kit, w, prospectId) => (await trade(kit, w, () => A("lib/services/trade-quotes").listTradeOpportunities())).opportunities.find((row) => row.id === prospectId)

// ---------------------------------------------------------------------------
// Stage 1: the invitation, claimed and tracked

const invited = (kit) => stage(kit, "invited", async (w) => {
  const quotes = A("lib/services/trade-quotes")
  const before = (await trade(kit, w, () => quotes.listTradeOpportunities())).invitations
  const claim = await claimInvitation(kit, w.owner, { tokenType: "bid", token: w.link.token })
  const after = (await trade(kit, w, () => quotes.listTradeOpportunities())).invitations
  const grantId = after[0]?.id
  const tracked = await trade(kit, w, () => quotes.trackBuilderInvitation(grantId))
  const again = await attempt(() => trade(kit, w, () => quotes.trackBuilderInvitation(grantId)))
  const remaining = (await trade(kit, w, () => quotes.listTradeOpportunities())).invitations
  return { before, claim, after, grantId, tracked, again, remaining }
})

async function invitationBecomesAnItb(kit, spec, check) {
  const w = await world(kit)
  const s = await invited(kit)
  const { q } = kit
  const opportunity = await opportunityOf(kit, w, s.tracked.id)
  const row = kit.rows(`select name, status, source, due_at, source_grant_id=${q(s.grantId)} grant_matches, notes, jobsite_location->>'street' street from public.prospects where id=${q(s.tracked.id)}`)[0]
  const contacts = kit.rows(`select full_name, company_name, email from public.prospect_contacts where prospect_id=${q(s.tracked.id)} and is_primary`)
  const observed = {
    invitationsBeforeTheOwnerClaimsAnything: s.before.length,
    claim: { createdAnIdentity: s.claim.created, forTheInvitedEmail: s.claim.email === w.owner.email.toLowerCase() },
    untrackedInvitations: s.after.map((item) => ({ builder: item.builder, project: item.project, dueOnThePackagesDate: iso(item.dueAt) === iso(w.due) })),
    opportunity: opportunity && { name: opportunity.name, customer: opportunity.customer, source: opportunity.source, fromInvitation: opportunity.fromInvitation, dueOnThePackagesDate: iso(opportunity.dueAt) === iso(w.due), move: moveOf(opportunity.move) },
    stored: { status: row.status, source: row.source, dueOnThePackagesDate: iso(row.due_at) === iso(w.due), tiedToTheGrant: row.grant_matches, notes: row.notes, address: row.street, primaryContact: contacts[0] },
    trackingAgain: s.again,
    invitationsLeftToTrack: s.remaining.length,
  }
  check.equal("a claimed bid invitation lists once, tracks into an opportunity with the builder as customer, the project's address and the package's due date three days out, and cannot be tracked twice", spec.expected, observed)
  return { orgId: w.t.orgId, builderOrgId: w.builder.orgId, prospectId: s.tracked.id }
}

// ---------------------------------------------------------------------------
// An invitation brings no way to reach the builder; the office adds one

async function anInvitedOpportunityCanBeSentAQuote(kit, spec, check) {
  const w = await world(kit)
  // The quote stage starts from the tracked invitation's customer (no email), proves a send refuses, then lets the office set one.
  const s = await quoted(kit)
  check.equal("an opportunity tracked from a builder invitation starts with no customer email, which is why its quote cannot be sent", { customerHasAnEmail: false }, { customerHasAnEmail: Boolean(s.contactBefore?.email?.trim()) })
  // The quote editor offers Send only when the customer has an email ("Add the customer's email to send it").
  check.equal("once the office sets the customer's email on the opportunity its quote can be sent to it", spec.expected, { customerHasAnEmail: Boolean(s.contactAfter?.email?.trim()) })
  return { orgId: w.t.orgId, prospectId: s.tracked.id }
}

// ---------------------------------------------------------------------------
// Stage 2: the quote

const setCustomerEmail = (kit, w, prospectId, contact, email = "estimating@builder.example.test") =>
  trade(kit, w, () => A("lib/services/trade-quotes").updateOpportunityCustomer({ prospect_id: prospectId, name: contact.name, company: contact.company, email, phone: contact.phone ?? "" }))

const quoted = (kit) => stage(kit, "quoted", async (w) => {
  const s = await invited(kit)
  const quotes = A("lib/services/trade-quotes")
  const saved = await trade(kit, w, () => quotes.saveTradeQuote({ prospect_id: s.tracked.id, quote: { title: "Electrical rough-in and trim", lines: QUOTE_LINES, tax_rate: TAX_RATE, valid_until: day(30), scope: "Rough-in, panel and trim-out for the Marina Way residence.", exclusions: "Permit fees.", terms: "Net 30." } }))
  // The customer of a tracked invitation has no email address: the quote will not send.
  const contactBefore = (await trade(kit, w, () => quotes.getTradeOpportunity(s.tracked.id))).contact
  const withoutEmail = await attempt(() => trade(kit, w, () => quotes.sendTradeQuote({ estimate_id: saved.id })))
  // The office has the builder's estimating inbox and sets it on the opportunity's customer.
  await setCustomerEmail(kit, w, s.tracked.id, contactBefore)
  const contactAfter = (await trade(kit, w, () => quotes.getTradeOpportunity(s.tracked.id))).contact
  return { ...s, estimateId: saved.id, contactBefore, contactAfter, withoutEmail }
})

async function quoteFromLaborMaterialAndMarkup(kit, spec, check) {
  const w = await world(kit)
  const s = await quoted(kit)
  const { q } = kit
  const estimate = kit.rows(`select title, status, version, subtotal_cents::int subtotal, tax_cents::int tax, total_cents::int total, valid_until::text valid_until, metadata->>'tax_rate' tax_rate from public.estimates where id=${q(s.estimateId)}`)[0]
  const items = kit.rows(`select item_type, description, quantity::float qty, unit, unit_cost_cents::int unit_cost, markup_pct::float markup, metadata->>'quote_kind' kind, coalesce((metadata->>'is_optional')::boolean, false) optional from public.estimate_items where estimate_id=${q(s.estimateId)} order by sort_order`)
  const opportunity = await opportunityOf(kit, w, s.tracked.id)
  const reloaded = (await trade(kit, w, () => A("lib/services/trade-quotes").getTradeOpportunity(s.tracked.id))).quote
  const observed = {
    estimate: { title: estimate.title, status: estimate.status, version: estimate.version, subtotalCents: estimate.subtotal, taxCents: estimate.tax, totalCents: estimate.total, validUntilIsThirtyDaysOut: estimate.valid_until === day(30), taxRate: Number(estimate.tax_rate) },
    items: items.map((item) => ({ type: item.item_type, description: item.description, quantity: item.qty, unit: item.unit, unitCostCents: item.unit_cost, markupPercent: item.markup, kind: item.kind, optional: item.optional })),
    editorReadsItBack: reloaded && {
      lines: reloaded.quote.lines.map((line) => `${line.section || "-"} | ${line.kind} | ${line.description}`),
      optionalLines: reloaded.quote.lines.filter((line) => line.optional).map((line) => line.description),
      totals: reloaded.totals,
      editable: reloaded.editable,
    },
    opportunity: opportunity && moveOf(opportunity.move),
  }
  check.equal("a quote of labor, material and equipment lines with markup, one optional add-on and 7% tax saves as sections and lines whose totals follow the estimate's own arithmetic, and the opportunity is Quoting at the quoted value", spec.expected, observed)
  return { orgId: w.t.orgId, estimateId: s.estimateId }
}

// ---------------------------------------------------------------------------
// Stage 3: sent on /e, followed up

const sent = (kit) => stage(kit, "sent", async (w) => {
  const s = await quoted(kit)
  const quotes = A("lib/services/trade-quotes")
  const { q } = kit
  const send = await trade(kit, w, () => quotes.sendTradeQuote({ estimate_id: s.estimateId, message: "Pricing attached. Call with any questions." }))
  const afterSend = await opportunityOf(kit, w, s.tracked.id)
  const followUpAfterSend = kit.rows(`select next_follow_up_at from public.prospects where id=${q(s.tracked.id)}`)[0].next_follow_up_at
  await trade(kit, w, () => quotes.logOpportunityContact(s.tracked.id, { kind: "call", note: "Walked the builder's estimator through the panel allowance." }))
  await trade(kit, w, () => quotes.setOpportunityFollowUp({ prospect_id: s.tracked.id, at: dayAt(5, "15:00:00.000Z"), note: "Ask for the award decision" }))
  const afterFollowUp = await opportunityOf(kit, w, s.tracked.id)
  return { ...s, send, afterSend, followUpAfterSend, afterFollowUp }
})

async function quoteSentOnThePortalAndFollowUpLogged(kit, spec, check) {
  const w = await world(kit)
  const s = await sent(kit)
  const { q } = kit
  const estimate = kit.rows(`select status, sent_at is not null sent, is_current_version, version from public.estimates where id=${q(s.estimateId)}`)[0]
  const prospect = kit.rows(`select status from public.prospects where id=${q(s.tracked.id)}`)[0]
  const links = kit.rows(`select count(*)::int n from public.estimate_review_links where estimate_id=${q(s.estimateId)}`)[0].n
  const portal = await A("lib/services/estimate-portal").loadEstimateByToken(s.send.url.split("/e/")[1])
  const activity = (await trade(kit, w, () => A("lib/services/prospects").listProspectActivity(s.tracked.id, w.t.orgId, 40)))
    .filter((entry) => ["estimate_sent", "prospect_contact_logged", "prospect_follow_up_set"].includes(entry.event_type))
    .map((entry) => ({ event: entry.event_type, detail: entry.payload?.kind ?? entry.payload?.note ?? entry.payload?.recipient_email ?? null }))
    .sort((a, b) => a.event.localeCompare(b.event))
  const observed = {
    sendWithoutACustomerEmail: s.withoutEmail,
    send: { emailSent: s.send.emailSent, linkIsTheReviewPage: /\/e\/[0-9a-f]{20,}$/.test(s.send.url) },
    estimate: { status: estimate.status, hasSentAt: estimate.sent, current: estimate.is_current_version, version: estimate.version },
    prospectStatus: prospect.status,
    reviewLinks: links,
    portalReads: portal && { title: portal.title, status: portal.status, totalCents: portal.total_cents, taxRate: portal.tax_rate, recipient: portal.recipient_email, lines: portal.items.filter((item) => item.item_type !== "group").length },
    followUpSetBySend: { daysOut: Math.round((Date.parse(s.followUpAfterSend) - Date.now()) / DAY) },
    stageAfterSend: moveOf(s.afterSend.move),
    stageAfterFollowUp: moveOf(s.afterFollowUp.move),
    trail: activity,
  }
  check.equal("a quote with no customer email will not send; with one it sends on a /e review link (no email leaves the stack), moves the opportunity to Sent with a follow-up three days out, and a logged call and a rescheduled follow-up land on the trail", spec.expected, observed)
  return { orgId: w.t.orgId, estimateId: s.estimateId }
}

// ---------------------------------------------------------------------------
// Stage 4: the customer says yes on the portal

const accepted = (kit) => stage(kit, "accepted", async (w) => {
  const s = await sent(kit)
  const token = s.send.url.split("/e/")[1]
  const decision = await A("lib/services/estimate-portal").submitEstimateDecision({ token, decision: "approved", note: "Approved. Please start the week of the 14th.", signature: { signer_name: "Marina Builders Estimating", consent_accepted: true }, ip: "203.0.113.7" })
  await kit.settle()
  const opportunity = await opportunityOf(kit, w, s.tracked.id)
  const again = await attempt(() => A("lib/services/estimate-portal").submitEstimateDecision({ token, decision: "approved", signature: { signer_name: "Marina Builders Estimating", consent_accepted: true } }))
  return { ...s, token, decision, opportunity, again }
})

async function customerAcceptsOnThePortal(kit, spec, check) {
  const w = await world(kit)
  const s = await accepted(kit)
  const { q } = kit
  const estimate = kit.rows(`select status, approved_at is not null approved, client_signed_at is not null signed, decision_note, client_decision_name, signature_data->'client'->>'signer_name' signed_by, metadata->'accepted_options'->>'accepted_total_cents' accepted_total, metadata->'accepted_options'->'ids' accepted_options from public.estimates where id=${q(s.estimateId)}`)[0]
  const prospect = kit.rows(`select status from public.prospects where id=${q(s.tracked.id)}`)[0]
  const events = kit.rows(`select event_type from public.events where org_id=${q(w.t.orgId)} and entity_type='estimate' and entity_id=${q(s.estimateId)} and event_type in ('estimate_client_signed','estimate_viewed')  order by event_type`).map((row) => row.event_type)
  const observed = {
    decision: s.decision,
    estimate: { status: estimate.status, approved: estimate.approved, clientSigned: estimate.signed, note: estimate.decision_note, decidedBy: estimate.client_decision_name, signedBy: estimate.signed_by, acceptedTotalCents: Number(estimate.accepted_total), addOnsAccepted: estimate.accepted_options },
    prospectStatus: prospect.status,
    events,
    stage: moveOf(s.opportunity.move),
    signingTwice: s.again,
  }
  check.equal("the customer signs on the review link declining the add-on; the quote is client-signed at the base total, the opportunity reads Won with the job still to start, and a second signature is refused", spec.expected, observed)
  return { orgId: w.t.orgId, estimateId: s.estimateId }
}

// ---------------------------------------------------------------------------
// Stage 5: the job

async function acceptedQuoteStartsAJob(kit, spec, check) {
  const w = await world(kit)
  const s = await accepted(kit)
  const { q } = kit
  const quotes = A("lib/services/trade-quotes")
  const before = (await trade(kit, w, () => quotes.getTradeOpportunity(s.tracked.id))).jobDraft
  const start = { prospect_id: s.tracked.id, name: "Marina Way residence - electrical", billing_basis: "progress", retainage_percent: 10, payment_terms_days: 30, customer_certifies: true, review_before_send: false, start_date: day(14), end_date: day(60) }
  const job = await trade(kit, w, () => quotes.startTradeJobFromQuote(start))
  const twice = await trade(kit, w, () => quotes.startTradeJobFromQuote(start))
  const row = kit.rows(`select p.name, p.status, p.phase, p.property_type, p.prospect_id=${q(s.tracked.id)} from_the_opportunity, p.retainage_percent, p.start_date::text start_date, p.end_date::text end_date, p.location->>'address' street,
      pfs.billing_model, pfs.fixed_price_billing_basis basis, pfs.metadata->'receivables' receivables, c.contract_type, c.total_cents,
      cl.full_name customer, p.client_id=(select contact_id from public.prospect_contacts where prospect_id=p.prospect_id and is_primary) is_the_opportunity_contact
    from public.projects p left join public.project_financial_settings pfs on pfs.project_id=p.id and pfs.org_id=p.org_id left join public.contracts c on c.project_id=p.id and c.org_id=p.org_id
      left join public.contacts cl on cl.id=p.client_id where p.id=${q(job.id)}`)[0]
  const jobs = Number(kit.rows(`select count(*)::int n from public.projects where org_id=${q(w.t.orgId)} and prospect_id=${q(s.tracked.id)}`)[0].n)
  const linked = kit.rows(`select project_id=${q(job.id)} on_the_job from public.estimates where id=${q(s.estimateId)}`)[0].on_the_job
  const prospect = kit.rows(`select status, won_at is not null won, next_follow_up_at is null no_follow_up from public.prospects where id=${q(s.tracked.id)}`)[0]
  const opportunity = await opportunityOf(kit, w, s.tracked.id)
  const observed = {
    draftBeforeStarting: { contractCents: before.total_contract_value_cents, billingBasis: before.billing_basis, customerKind: before.customer_kind, retainagePercent: before.retainage_percent, paymentTermsDays: before.payment_terms_days },
    job: { name: row.name, status: row.status, phase: row.phase, posture: row.property_type, fromTheOpportunity: row.from_the_opportunity, startsInTwoWeeks: row.start_date === day(14), endsInTwoMonths: row.end_date === day(60), address: row.street },
    contract: { type: row.contract_type, contractCents: Number(row.total_cents) },
    billing: { model: row.billing_model, basis: row.basis, retainagePercent: Number(row.retainage_percent), receivables: row.receivables },
    customer: { name: row.customer, isTheOpportunitysDirectoryContact: row.is_the_opportunity_contact },
    quoteIsOnTheJob: linked,
    opportunity: { status: prospect.status, wonAtSet: prospect.won, followUpCleared: prospect.no_follow_up, stage: moveOf(opportunity.move), jobLinked: opportunity.jobId === job.id },
    startingTwice: { sameJob: twice.id === job.id, alreadyStarted: twice.alreadyStarted, jobsForTheOpportunity: jobs },
  }
  check.equal("starting the accepted quote's job carries the accepted base price as the contract, the builder as customer and the billing the office confirmed (progress, 10% retainage, net 30, certified), marks the opportunity won, and a second start returns the same job", spec.expected, observed)
  return { orgId: w.t.orgId, projectId: job.id }
}

module.exports = {
  id: "TRADE-QUOTE-01",
  subcases: {
    "invitation-becomes-an-itb-with-a-due-date": invitationBecomesAnItb,
    "an-invited-opportunity-can-be-sent-a-quote": anInvitedOpportunityCanBeSentAQuote,
    "quote-from-labor-material-and-markup": quoteFromLaborMaterialAndMarkup,
    "quote-sent-on-the-portal-and-follow-up-logged": quoteSentOnThePortalAndFollowUpLogged,
    "customer-accepts-on-the-portal": customerAcceptsOnThePortal,
    "accepted-quote-starts-a-job-with-its-terms": acceptedQuoteStartsAJob,
  },
}
