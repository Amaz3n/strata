"use strict"

// Trade quoting (lib/trade/quote and lib/services/trade-quotes): opportunities,
// quotes priced from labor, material and equipment, acceptance and the job it starts.

require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const {
  compareOpportunities,
  quoteEstimateLines,
  quoteFunnel,
  quoteJobDraft,
  quoteLinesFromEstimate,
  quoteMove,
  quoteTotals,
} = require("@/lib/trade/quote")
const { calculateEstimateTotals } = require("@/lib/financials/estimate-totals")
const { formatLostReason, parseLostReason } = require("@/lib/sales/lost-reasons")

// Starting the job hands a trade job to createTradeJob, whose project creation has its own suite.
let jobsCreated = []
stubModule("@/lib/services/trade-workspace", {
  createTradeJob: async (input, origin) => {
    jobsCreated.push({ input, origin })
    return { id: id(9000 + jobsCreated.length) }
  },
})

const { closeTradeOpportunity, recordQuoteAcceptance, startTradeJobFromQuote, updateOpportunityCustomer } = freshRequire(
  "lib/services/trade-quotes.ts",
)

const NOW = new Date("2026-10-19T15:00:00Z")
const line = (overrides) => ({
  kind: "labor",
  section: "",
  description: "Rough-in",
  quantity: 8,
  unit: "hr",
  unit_price_cents: 9500,
  markup_percent: 0,
  optional: false,
  rate_id: null,
  ...overrides,
})
const facts = (overrides) => ({ status: "new", lostReason: null, dueAt: null, followUpAt: null, quote: null, jobId: null, ...overrides })
const quote = (overrides) => ({ status: "draft", sentAt: null, totalCents: 120000, acceptedTotalCents: null, ...overrides })

test("an opportunity moves Invited → Quoting → Sent → Won by its documents, never a stored stage", () => {
  const invited = quoteMove(facts({ dueAt: "2026-10-20T22:00:00Z" }), NOW)
  assert.deepEqual([invited.stage, invited.action, invited.tone], ["invited", "build_quote", "soon"])
  assert.equal(invited.sentence, "Price is due tomorrow")

  const late = quoteMove(facts({ dueAt: "2026-10-16T22:00:00Z", quote: quote() }), NOW)
  assert.deepEqual([late.stage, late.action, late.tone], ["quoting", "finish_quote", "late"])
  assert.equal(late.sentence, "Price was due 3 days ago")

  const sent = quoteMove(facts({ status: "estimate_sent", quote: quote({ status: "sent", sentAt: "2026-10-15T15:00:00Z" }) }), NOW)
  assert.deepEqual([sent.stage, sent.action, sent.sentence], ["sent", "follow_up", "Sent. Set a follow-up"])
  const overdue = quoteMove(
    facts({ followUpAt: "2026-10-18T15:00:00Z", quote: quote({ status: "sent", sentAt: "2026-10-15T15:00:00Z" }) }),
    NOW,
  )
  assert.deepEqual([overdue.sentence, overdue.tone], ["Follow-up is overdue", "late"])
  const changes = quoteMove(facts({ quote: quote({ status: "changes_requested", sentAt: "2026-10-15T15:00:00Z" }) }), NOW)
  assert.equal(changes.action, "revise")

  // Accepted with an add-on: the deal is worth what the customer accepted.
  const won = quoteMove(facts({ quote: quote({ status: "client_signed", sentAt: "x", acceptedTotalCents: 135000 }) }), NOW)
  assert.deepEqual([won.stage, won.action, won.valueCents], ["won", "start_job", 135000])
  assert.equal(quoteMove(facts({ status: "won", jobId: id(1), quote: quote({ status: "approved" }) }), NOW).action, "open_job")
})

test("declining is a lost deal with a declined reason, and it reads as Declined", () => {
  const declined = quoteMove(facts({ status: "lost", lostReason: "declined_scope: two hours out" }), NOW)
  assert.deepEqual([declined.stage, declined.label, declined.action], ["lost", "Declined", "reopen"])
  assert.equal(declined.sentence, "Declined: not our scope — two hours out")
  assert.equal(quoteMove(facts({ status: "lost", lostReason: "competitor" }), NOW).label, "Lost")
  assert.deepEqual(parseLostReason("declined_capacity"), { code: "declined_capacity", note: null })
  // Builder reasons and free text read back as before.
  assert.equal(formatLostReason("financing"), "Financing fell through")
  assert.equal(formatLostReason("they moved"), "they moved")
})

test("a quote's totals are the estimate's totals: labor, material with markup, add-ons out, tax on the base", () => {
  const lines = [
    line({}),
    line({ kind: "material", description: "Wire and boxes", quantity: 1, unit: "lot", unit_price_cents: 34000, markup_percent: 15 }),
    line({ kind: "equipment", description: "Lift", quantity: 2, unit: "day", unit_price_cents: 18000 }),
    line({ kind: "material", description: "Upgrade to LED", quantity: 1, unit: "ea", unit_price_cents: 25000, optional: true }),
  ]
  const totals = quoteTotals(lines, 8)
  assert.deepEqual(totals.byKind, { labor: 76000, material: 39100, equipment: 36000, other: 0 })
  assert.equal(totals.optional, 25000)
  assert.equal(totals.subtotal, 151100)
  assert.equal(totals.tax, 12088)
  // What the estimate stores from the same lines.
  assert.equal(calculateEstimateTotals(quoteEstimateLines(lines), 8).total, totals.total)
})

test("sections become group rows in first-use order and read back into the same lines", () => {
  const lines = [
    line({ section: "Service", description: "Panel swap" }),
    line({ description: "Permit", kind: "other", quantity: 1, unit: "ea", unit_price_cents: 15000 }),
    line({ section: "Lighting", kind: "material", description: "Fixtures", quantity: 12, unit: "ea", unit_price_cents: 4500, markup_percent: 20 }),
    line({ section: "Service", description: "Grounding", rate_id: id(5) }),
  ]
  const stored = quoteEstimateLines(lines)
  assert.deepEqual(
    stored.map((row) => [row.item_type, row.description]),
    [["line", "Permit"], ["group", "Service"], ["line", "Panel swap"], ["line", "Grounding"], ["group", "Lighting"], ["line", "Fixtures"]],
  )
  const readBack = quoteLinesFromEstimate(
    stored.map((row) => ({ ...row, unit: row.unit ?? null, metadata: { ...row.metadata, ...(row.is_optional ? { is_optional: true } : {}) } })),
  )
  assert.deepEqual(readBack, [lines[1], lines[0], lines[3], lines[2]])
})

test("the desk counts and values each stage, and lists open work by due date before closed deals", () => {
  const rows = [
    { name: "closed", dueAt: null, updatedAt: "2026-10-18", move: quoteMove(facts({ status: "lost", lostReason: "price" }), NOW) },
    { name: "undated", dueAt: null, updatedAt: "2026-10-18", move: quoteMove(facts({}), NOW) },
    { name: "later", dueAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-01", move: quoteMove(facts({ quote: quote() }), NOW) },
    { name: "sooner", dueAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-01", move: quoteMove(facts({ quote: quote({ totalCents: 5000 }) }), NOW) },
  ]
  assert.deepEqual([...rows].sort(compareOpportunities).map((row) => row.name), ["sooner", "later", "undated", "closed"])
  const funnel = quoteFunnel(rows.map((row) => row.move))
  assert.deepEqual(funnel.quoting, { count: 2, valueCents: 125000 })
  assert.deepEqual(funnel.invited, { count: 1, valueCents: 0 })
  assert.equal(funnel.lost.count, 1)
})

test("a builder customer's job defaults to progress billing with retainage; a homeowner's to invoices", () => {
  const draft = (customerIsCompany) =>
    quoteJobDraft({ name: "Maple Clinic", clientId: null, address: "", scope: "", customerIsCompany, acceptedTotalCents: 125000, propertyType: "residential" })
  assert.deepEqual(
    [draft(true).billing_basis, draft(true).retainage_percent, draft(true).customer_certifies, draft(true).total_contract_value_cents],
    ["progress", 10, true, 125000],
  )
  assert.deepEqual([draft(false).billing_basis, draft(false).retainage_percent], ["invoices", 0])
})

// ── Service ────────────────────────────────────────────────────────────────

const DEAL = id(100)
const QUOTE = id(101)
const CUSTOMER = id(102)

function tradeTables({ quoteRow = {}, prospect = {}, projects = [] } = {}) {
  const estimate = {
    id: QUOTE,
    org_id: ORG,
    prospect_id: DEAL,
    project_id: null,
    title: "Maple Clinic quote",
    status: "sent",
    version: 1,
    sent_at: "2026-10-15T15:00:00Z",
    total_cents: 120000,
    is_current_version: true,
    created_at: "2026-10-14T15:00:00Z",
    updated_at: "2026-10-15T15:00:00+00:00",
    metadata: {},
    accepted: null,
    ...quoteRow,
  }
  return {
    org_settings: [{ org_id: ORG, settings: { business_profile: { kind: "trade", specialty: "Electrical" } } }],
    orgs: [{ id: ORG }],
    estimates: [estimate],
    // The fake does not join: the prospect row carries what the select embeds.
    prospects: [
      {
        id: DEAL,
        org_id: ORG,
        name: "Maple Clinic",
        status: "estimate_sent",
        owner_user_id: ACTOR,
        community_id: null,
        source: "builder_invitation",
        notes: "Tenant improvement",
        lost_reason: null,
        due_at: "2026-10-16T22:00:00Z",
        next_follow_up_at: null,
        source_grant_id: null,
        jobsite_location: { street: "12 Main St" },
        tags: [],
        created_at: "2026-10-10T15:00:00Z",
        updated_at: "2026-10-15T15:00:00+00:00",
        contacts: [
          { id: id(103), full_name: "Dana Ruiz", company_name: "Ruiz Builders", email: "dana@example.com", phone: null, is_primary: true, contact_id: CUSTOMER, promoted_contact_id: null },
        ],
        quotes: [estimate],
        jobs: projects,
        ...prospect,
      },
    ],
    prospect_contacts: [],
    projects,
  }
}

test("a quote the customer accepted by phone is recorded once, at its price, and wins the opportunity", async () => {
  const service = createServiceHarness({ tables: tradeTables(), permissions: ["org.member", "pipeline.write", "project.manage"] })
  await service.run(() => recordQuoteAcceptance({ estimate_id: QUOTE, accepted_by: "Dana Ruiz", note: "Called it in" }))
  const [estimate] = service.db.estimates
  assert.equal(estimate.status, "approved")
  assert.equal(estimate.client_decision_name, "Dana Ruiz")
  assert.equal(estimate.metadata.accepted_options.accepted_total_cents, 120000)
  assert.equal(service.db.prospects[0].status, "client_approved")
  assert.ok(service.events.some((event) => event.eventType === "estimate_accepted_outside_portal"))
  await assert.rejects(
    service.run(() => recordQuoteAcceptance({ estimate_id: QUOTE, accepted_by: "Dana Ruiz" })),
    /already accepted/,
  )
})

test("an accepted quote starts one job carrying the customer, the accepted price and the confirmed billing", async () => {
  jobsCreated = []
  const start = {
    prospect_id: DEAL,
    name: "Maple Clinic",
    billing_basis: "progress",
    retainage_percent: 10,
    payment_terms_days: 30,
    customer_certifies: true,
    review_before_send: false,
  }
  const unaccepted = createServiceHarness({ tables: tradeTables(), permissions: ["org.member", "pipeline.write", "project.manage"] })
  await assert.rejects(unaccepted.run(() => startTradeJobFromQuote(start)), /acceptance/)
  assert.equal(jobsCreated.length, 0)

  const accepted = { status: "client_signed", accepted: { accepted_total_cents: 135000 } }
  const service = createServiceHarness({ tables: tradeTables({ quoteRow: accepted }), permissions: ["org.member", "pipeline.write", "project.manage"] })
  const result = await service.run(() => startTradeJobFromQuote(start))
  assert.equal(result.alreadyStarted, false)
  assert.equal(jobsCreated.length, 1)
  const [{ input, origin }] = jobsCreated
  assert.deepEqual(origin, { prospectId: DEAL })
  assert.equal(input.total_contract_value_cents, 135000)
  assert.equal(input.client_id, CUSTOMER)
  assert.equal(input.billing_basis, "progress")
  assert.equal(input.address, "12 Main St")
  assert.equal(service.db.prospects[0].status, "won")
  assert.equal(service.db.estimates[0].project_id, result.id)

  // Starting again finds the job the opportunity already started.
  const job = { id: id(9100), org_id: ORG, prospect_id: DEAL, phase: "delivery" }
  const again = createServiceHarness({
    tables: tradeTables({ quoteRow: accepted, prospect: { status: "won" }, projects: [job] }),
    permissions: ["org.member", "pipeline.write", "project.manage"],
  })
  assert.deepEqual(await again.run(() => startTradeJobFromQuote(start)), { id: job.id, alreadyStarted: true })
  assert.equal(jobsCreated.length, 1)
})

test("declining keeps the quote and closes the opportunity with a declined reason", async () => {
  const service = createServiceHarness({ tables: tradeTables(), permissions: ["org.member", "pipeline.write"] })
  await service.run(() =>
    closeTradeOpportunity({ prospect_id: DEAL, outcome: "declined", reason_code: "declined_capacity", note: "Booked through March" }),
  )
  const [prospect] = service.db.prospects
  assert.equal(prospect.status, "lost")
  assert.equal(prospect.lost_reason, "declined_capacity: Booked through March")
  assert.equal(service.db.estimates.length, 1)
  await assert.rejects(
    service.run(() => closeTradeOpportunity({ prospect_id: DEAL, outcome: "lost", reason_code: "declined_scope" })),
  )
})

test("closing an opportunity withdraws the review link of the quote the customer had not answered", async () => {
  const tables = tradeTables()
  tables.estimate_review_links = [
    { token_hash: "h1", org_id: ORG, estimate_id: QUOTE },
    { token_hash: "h2", org_id: ORG, estimate_id: id(555) },
  ]
  tables.estimates[0].token_hash = "legacy"
  const service = createServiceHarness({ tables, permissions: ["org.member", "pipeline.write"] })
  await service.run(() => closeTradeOpportunity({ prospect_id: DEAL, outcome: "declined", reason_code: "declined_capacity" }))
  assert.deepEqual(service.db.estimate_review_links.map((link) => link.token_hash), ["h2"])
  assert.equal(service.db.estimates[0].token_hash, null)
})

test("the office sets the customer's name, email and phone on the opportunity, and the linked directory contact follows", async () => {
  const tables = tradeTables({ prospect: { status: "new" }, quoteRow: { status: "draft", metadata: { recipient: { name: "Dana Ruiz", email: "old@ruiz.example" } } } })
  const contact = { ...tables.prospects[0].contacts[0], email: null, prospect_id: DEAL, org_id: ORG, role: "Builder", metadata: {}, created_at: "2026-10-10T15:00:00Z", updated_at: "2026-10-10T15:00:00Z" }
  tables.prospect_contacts = [contact]
  tables.prospects[0].contacts = [contact]
  tables.contacts = [{ id: CUSTOMER, org_id: ORG, full_name: "Dana Ruiz", email: null, phone: null, contact_type: "client", metadata: {}, created_at: "2026-10-10T15:00:00Z", updated_at: "2026-10-10T15:00:00Z" }]
  const input = { prospect_id: DEAL, name: "Dana Ruiz", company: "Ruiz Builders", email: "estimating@ruiz.example", phone: "555-0100" }

  const denied = createServiceHarness({ tables, permissions: ["org.member"] })
  await assert.rejects(denied.run(() => updateOpportunityCustomer(input)))
  await assert.rejects(denied.run(() => updateOpportunityCustomer({ ...input, email: "not-an-email" })))

  const service = createServiceHarness({ tables, permissions: ["org.member", "pipeline.write", "directory.write"] })
  await service.run(() => updateOpportunityCustomer(input))
  assert.equal(service.db.prospect_contacts[0].email, "estimating@ruiz.example")
  assert.equal(service.db.prospect_contacts[0].phone, "555-0100")
  assert.equal(service.db.contacts[0].email, "estimating@ruiz.example")
  assert.deepEqual(service.db.estimates[0].metadata.recipient, { name: "Dana Ruiz", email: "estimating@ruiz.example" }, "an unsent quote follows the corrected email")
  assert.ok(service.audits.some((entry) => entry.entityType === "prospect" && entry.entityId === DEAL))
  await assert.rejects(service.run(() => updateOpportunityCustomer({ ...input, name: "", company: "" })))
})
