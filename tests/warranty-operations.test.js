require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { describe } = test
const {
  buildCostBasisFromVisits,
  computeVisitInternalCost,
  courtesyInspectionSchedule,
  dueCourtesyInspections,
  findOverlappingVisits,
  mergeMetadata,
  rankOriginatingCommitments,
  validateWarrantyCostBasis,
  warrantyFirstResponseState,
  warrantyResolutionState,
  TRADE_REPORTABLE_OUTCOMES,
} = require("../lib/services/warranty/domain")

test("metadata merges instead of replacing, so a breach survives a visit", () => {
  // A breached request that receives a visit used to silently un-breach, then get
  // re-flagged by the next sweep.
  const existing = { sla_breached_at: "2026-08-01T00:00:00.000Z", cost_dump_reason: "60-day window" }
  const merged = mergeMetadata(existing, { pending_verification: true, completed_visit_id: "visit-1" })
  assert.equal(merged.sla_breached_at, "2026-08-01T00:00:00.000Z")
  assert.equal(merged.cost_dump_reason, "60-day window")
  assert.equal(merged.pending_verification, true)
  assert.equal(merged.completed_visit_id, "visit-1")
})

test("metadata merge treats undefined as untouched and null as a delete", () => {
  const merged = mergeMetadata(
    { sla_breached_at: "x", first_response_breached_at: "y", keep: 1 },
    { first_response_breached_at: null, sla_breached_at: undefined, added: true },
  )
  assert.equal(merged.sla_breached_at, "x")
  assert.equal("first_response_breached_at" in merged, false)
  assert.equal(merged.keep, 1)
  assert.equal(merged.added, true)
})

test("metadata merge tolerates null, arrays, and non-objects on the row", () => {
  assert.deepEqual(mergeMetadata(null, { a: 1 }), { a: 1 })
  assert.deepEqual(mergeMetadata(undefined, { a: 1 }), { a: 1 })
  assert.deepEqual(mergeMetadata([1, 2], { a: 1 }), { a: 1 })
})

test("internal visit cost is hours x rate plus materials, in whole cents", () => {
  const cost = computeVisitInternalCost({ labor_hours: 2.5, labor_rate_cents: 8500, material_cents: 4200 })
  assert.equal(cost.internal_labor_cents, 21250)
  assert.equal(cost.internal_material_cents, 4200)
  assert.equal(cost.internal_total_cents, 25450)
  assert.equal(Number.isInteger(cost.internal_labor_cents), true)
})

test("internal visit cost rounds to the cent and defaults to zero", () => {
  assert.equal(computeVisitInternalCost({ labor_hours: 1.333, labor_rate_cents: 9999 }).internal_labor_cents, 13329)
  const empty = computeVisitInternalCost({})
  assert.equal(empty.internal_total_cents, 0)
  assert.equal(empty.labor_hours, null)
})

test("internal visit cost rejects nonsense inputs rather than storing them", () => {
  assert.throws(() => computeVisitInternalCost({ labor_hours: -1, labor_rate_cents: 100 }), /Labor hours/)
  assert.throws(() => computeVisitInternalCost({ labor_hours: 40, labor_rate_cents: 100 }), /Labor hours/)
  assert.throws(() => computeVisitInternalCost({ labor_hours: 2 }), /labor rate is required/)
  assert.throws(() => computeVisitInternalCost({ labor_rate_cents: 10.5 }), /whole-cent/)
  assert.throws(() => computeVisitInternalCost({ material_cents: -5 }), /whole-cent/)
})

test("a cost basis built from visits validates against the backcharge amount", () => {
  const visits = [
    { id: "v1", visit_number: 1, assigned_user_name: "Dana", labor_hours: 2, labor_rate_cents: 8500, internal_labor_cents: 17000, internal_material_cents: 3000 },
    { id: "v2", visit_number: 2, assigned_user_name: null, labor_hours: 1, labor_rate_cents: 8500, internal_labor_cents: 8500, internal_material_cents: 0 },
  ]
  const basis = buildCostBasisFromVisits(visits)
  assert.equal(basis.length, 3)
  assert.equal(basis[0].ref_type, "warranty_service_visit")
  assert.equal(basis[0].ref_id, "v1")
  assert.match(basis[0].label, /Visit 1 labor \(Dana\)/)
  const total = basis.reduce((sum, item) => sum + item.amount_cents, 0)
  assert.equal(total, 28500)
  assert.doesNotThrow(() => validateWarrantyCostBasis(total, basis))
  assert.throws(() => validateWarrantyCostBasis(total - 1, basis), /equal/)
})

test("zero-cost visits contribute no cost-basis lines", () => {
  assert.deepEqual(buildCostBasisFromVisits([{ id: "v1", visit_number: 1, internal_labor_cents: 0, internal_material_cents: 0 }]), [])
})

test("originating POs rank trade-and-cost-code above either alone", () => {
  const candidates = [
    { id: "c-none", title: "Landscaping", contract_number: "PO-4", company_id: "other", company_name: "Green", total_cents: 100, status: "executed", cost_code_ids: ["cc-other"] },
    { id: "c-company", title: "Plumbing rough", contract_number: "PO-2", company_id: "plumber", company_name: "Ace", total_cents: 100, status: "executed", cost_code_ids: ["cc-other"] },
    { id: "c-code", title: "Trim carpentry", contract_number: "PO-3", company_id: "other", company_name: "Green", total_cents: 100, status: "executed", cost_code_ids: ["cc-plumb"] },
    { id: "c-both", title: "Plumbing finish", contract_number: "PO-1", company_id: "plumber", company_name: "Ace", total_cents: 100, status: "executed", cost_code_ids: ["cc-plumb"] },
  ]
  const ranked = rankOriginatingCommitments(candidates, { costCodeId: "cc-plumb", companyId: "plumber" })
  assert.deepEqual(ranked.map((row) => row.id), ["c-both", "c-code", "c-company", "c-none"])
  assert.equal(ranked[0].match_reason, "Same trade and cost code")
  assert.equal(ranked[1].match_reason, "Cost code match")
  assert.equal(ranked[2].match_reason, "Same trade")
  assert.equal(ranked[3].match_reason, "No match on trade or cost code")
  assert.equal(ranked[0].exact_cost_code, true)
  assert.equal(ranked[3].same_company, false)
})

test("originating PO ranking is stable with nothing to match on", () => {
  const candidates = [
    { id: "b", title: "Beta", contract_number: null, company_id: null, company_name: null, total_cents: 0, status: "draft", cost_code_ids: [] },
    { id: "a", title: "Alpha", contract_number: null, company_id: null, company_name: null, total_cents: 0, status: "draft", cost_code_ids: [] },
  ]
  assert.deepEqual(rankOriginatingCommitments(candidates, {}).map((row) => row.title), ["Alpha", "Beta"])
})

test("first response and resolution SLAs breach on their own clocks", () => {
  const now = new Date("2026-08-17T12:00:00.000Z")
  const request = {
    first_response_due_at: "2026-08-17T06:00:00.000Z",
    resolution_due_at: "2026-09-10T12:00:00.000Z",
    first_responded_at: null,
    status: "open",
  }
  // First response is overdue while resolution is still comfortably on track:
  // the old code only ever tested the resolution target.
  assert.equal(warrantyFirstResponseState(request, now), "breached")
  assert.equal(warrantyResolutionState(request, now), "on_track")

  assert.equal(warrantyFirstResponseState({ ...request, first_responded_at: "2026-08-17T05:00:00.000Z" }, now), "met")
  assert.equal(warrantyFirstResponseState({ ...request, first_response_due_at: "2026-08-17T20:00:00.000Z" }, now), "due_soon")
  assert.equal(warrantyFirstResponseState({ ...request, first_response_due_at: "2026-08-19T20:00:00.000Z" }, now), "on_track")
  assert.equal(warrantyFirstResponseState({ first_response_due_at: null, first_responded_at: null }, now), "unset")
})

test("resolution SLA reports met once the request closes, breached while it is open", () => {
  const now = new Date("2026-08-17T12:00:00.000Z")
  assert.equal(warrantyResolutionState({ resolution_due_at: "2026-08-01T00:00:00.000Z", status: "in_progress" }, now), "breached")
  assert.equal(warrantyResolutionState({ resolution_due_at: "2026-08-01T00:00:00.000Z", status: "resolved" }, now), "met")
  assert.equal(warrantyResolutionState({ resolution_due_at: "2026-08-18T00:00:00.000Z", status: "open" }, now), "due_soon")
  assert.equal(warrantyResolutionState({ resolution_due_at: null, status: "open" }, now), "unset")
})

test("courtesy inspections land 30 days and 11 months off the coverage start", () => {
  const schedule = courtesyInspectionSchedule("2026-01-31")
  assert.deepEqual(schedule.map((milestone) => milestone.key), ["day_30", "month_11"])
  assert.equal(schedule[0].due_on, "2026-03-02")
  // 11 months lands inside the workmanship year and clamps the short month.
  assert.equal(schedule[1].due_on, "2026-12-31")
  assert.equal(courtesyInspectionSchedule("2026-03-31")[1].due_on, "2027-02-28")
  assert.throws(() => courtesyInspectionSchedule("not-a-date"), /Invalid coverage effective date/)
})

test("only courtesy milestones inside the lead and grace window are due", () => {
  const asOf = new Date("2026-08-17T00:00:00.000Z")
  // Closed 25 days ago: the 30-day walk is 5 days out, inside the 14-day lead.
  assert.deepEqual(dueCourtesyInspections("2026-07-23", asOf).map((m) => m.key), ["day_30"])
  // Closed 11 months ago: the 11-month walk is due now, the 30-day one long past.
  assert.deepEqual(dueCourtesyInspections("2025-09-17", asOf).map((m) => m.key), ["month_11"])
  // Closed yesterday: nothing due yet.
  assert.deepEqual(dueCourtesyInspections("2026-08-16", asOf), [])
  // Closed three years ago: nothing gets sprayed into the queue retroactively.
  assert.deepEqual(dueCourtesyInspections("2023-08-17", asOf), [])
})

test("overlapping visit windows are conflicts and back-to-back ones are not", () => {
  const existing = [
    { id: "v1", window_start: "2026-08-17T14:00:00.000Z", window_end: "2026-08-17T16:00:00.000Z" },
    { id: "v2", window_start: "2026-08-17T16:00:00.000Z", window_end: "2026-08-17T18:00:00.000Z" },
  ]
  assert.deepEqual(
    findOverlappingVisits(existing, { window_start: "2026-08-17T15:00:00.000Z", window_end: "2026-08-17T17:00:00.000Z" }).map((v) => v.id),
    ["v1", "v2"],
  )
  assert.deepEqual(findOverlappingVisits(existing, { window_start: "2026-08-17T18:00:00.000Z", window_end: "2026-08-17T19:00:00.000Z" }), [])
  assert.deepEqual(findOverlappingVisits(existing, { window_start: "2026-08-17T12:00:00.000Z", window_end: "2026-08-17T14:00:00.000Z" }), [])
  // Rescheduling a visit does not conflict with itself.
  assert.deepEqual(
    findOverlappingVisits(existing, { window_start: "2026-08-17T14:30:00.000Z", window_end: "2026-08-17T15:30:00.000Z", exclude_visit_id: "v1" }),
    [],
  )
})

test("trades cannot report a coverage determination from the portal", () => {
  assert.deepEqual([...TRADE_REPORTABLE_OUTCOMES], ["resolved", "needs_followup", "needs_parts"])
  assert.equal(TRADE_REPORTABLE_OUTCOMES.includes("not_warrantable"), false)
})

// ---------------------------------------------------------------------------
// SLA history: a breach is a fact about the past.
// ---------------------------------------------------------------------------

const {
  completionAwaitsVerification,
  warrantySlaBreachStamps,
} = require("../lib/services/warranty/domain")

test("a request closed after its due time stays breached; one closed in time is met", () => {
  const now = new Date("2026-08-17T12:00:00.000Z")
  const due = "2026-08-01T00:00:00.000Z"
  assert.equal(warrantyResolutionState({ resolution_due_at: due, status: "resolved", closed_at: "2026-08-05T00:00:00.000Z" }, now), "breached")
  assert.equal(warrantyResolutionState({ resolution_due_at: due, status: "closed", closed_at: "2026-07-30T00:00:00.000Z" }, now), "met")
  assert.equal(warrantyFirstResponseState({ first_response_due_at: due, first_responded_at: "2026-08-02T00:00:00.000Z" }, now), "breached")
})

test("a recorded breach outlives a severity change that moved the due date out", () => {
  const now = new Date("2026-08-17T12:00:00.000Z")
  const request = { resolution_due_at: "2026-08-10T00:00:00.000Z", first_response_due_at: "2026-08-02T00:00:00.000Z", first_responded_at: null, status: "in_progress", metadata: {} }
  const stamps = warrantySlaBreachStamps(request, now)
  assert.deepEqual(stamps, { sla_breached_at: "2026-08-10T00:00:00.000Z", first_response_breached_at: "2026-08-02T00:00:00.000Z" })

  const regraded = { ...request, resolution_due_at: "2026-09-30T00:00:00.000Z", first_response_due_at: "2026-09-01T00:00:00.000Z", metadata: stamps }
  assert.equal(warrantyResolutionState(regraded, now), "breached")
  assert.equal(warrantyFirstResponseState(regraded, now), "breached")
  // Nothing new to stamp, and an on-track request has nothing to stamp at all.
  assert.deepEqual(warrantySlaBreachStamps(regraded, now), {})
  assert.deepEqual(warrantySlaBreachStamps({ ...request, resolution_due_at: "2026-09-30T00:00:00.000Z", first_responded_at: "2026-08-01T00:00:00.000Z" }, now), {})
})

test("an office resolution closes the request only with evidence; a trade report always waits", () => {
  const office = { source: "office", outcome: "resolved", photoCount: 0, buyerSignoffName: null }
  assert.equal(completionAwaitsVerification(office), true)
  assert.equal(completionAwaitsVerification({ ...office, buyerSignoffName: "  " }), true)
  assert.equal(completionAwaitsVerification({ ...office, photoCount: 1 }), false)
  assert.equal(completionAwaitsVerification({ ...office, buyerSignoffName: "Dana Buyer" }), false)
  assert.equal(completionAwaitsVerification({ ...office, outcome: "needs_parts" }), false)
  assert.equal(completionAwaitsVerification({ ...office, source: "portal", photoCount: 3 }), true)
})

describe("routing rules", () => {
  const { selectWarrantyRoutingRule } = require("../lib/services/warranty/domain")
  const rule = (id, overrides = {}) => ({ id, name: id, priority: 100, severity: null, category: null, community_id: null, cost_code_id: null, assignee_kind: "tech", assigned_user_id: "tech", assigned_company_id: null, is_active: true, ...overrides })
  const request = { severity: "emergency", category: "HVAC", community_id: "ridge", cost_code_id: "cc-hvac" }

  test("the lowest priority number wins, then the rule that says the most", () => {
    const rules = [rule("catch-all"), rule("severity", { severity: "emergency" }), rule("severity+community", { severity: "emergency", community_id: "ridge" }), rule("urgent", { priority: 1, category: "hvac" })]
    assert.equal(selectWarrantyRoutingRule(rules, request).id, "urgent")
    assert.equal(selectWarrantyRoutingRule(rules.slice(0, 3), request).id, "severity+community")
  })

  test("every condition a rule sets must agree; category ignores case", () => {
    assert.equal(selectWarrantyRoutingRule([rule("other-community", { community_id: "elsewhere" })], request), null)
    assert.equal(selectWarrantyRoutingRule([rule("routine", { severity: "routine_30" })], request), null)
    assert.equal(selectWarrantyRoutingRule([rule("hvac", { category: " hvac " })], request).id, "hvac")
    assert.equal(selectWarrantyRoutingRule([rule("responsibility", { cost_code_id: "cc-hvac" })], request).id, "responsibility")
    assert.equal(selectWarrantyRoutingRule([rule("home-without-community", { community_id: "ridge" })], { ...request, community_id: null }), null)
  })

  test("an inactive rule routes nothing, and ties resolve the same way every time", () => {
    assert.equal(selectWarrantyRoutingRule([rule("off", { is_active: false })], request), null)
    assert.equal(selectWarrantyRoutingRule([rule("b"), rule("a")], request).id, "a")
  })
})

describe("visit times at the house", () => {
  const {
    formatWarrantyVisitWindow, resolveWarrantyTimeZone, warrantyLocalDate, zonedStartOfDay, zonedWallTimeToUtc,
  } = require("../lib/services/warranty/visit-time")
  const NY = "America/New_York"

  test("a window reads in the house's zone with the zone named, across daylight time", () => {
    assert.equal(formatWarrantyVisitWindow("2026-10-12T13:00:00Z", "2026-10-12T15:00:00Z", NY), "Oct 12, 2026, 9:00 AM – 11:00 AM EDT")
    assert.equal(formatWarrantyVisitWindow("2026-12-12T13:00:00Z", "2026-12-12T15:00:00Z", NY), "Dec 12, 2026, 8:00 AM – 10:00 AM EST")
    assert.equal(formatWarrantyVisitWindow("2026-10-12T13:00:00Z", "2026-10-12T15:00:00Z", "America/Chicago"), "Oct 12, 2026, 8:00 AM – 10:00 AM CDT")
  })

  test("a window that crosses local midnight names both days", () => {
    assert.match(formatWarrantyVisitWindow("2026-10-13T02:00:00Z", "2026-10-13T05:00:00Z", NY), /Oct 12, 2026, 10:00 PM EDT – Oct 13, 2026, 1:00 AM EDT/)
  })

  test("the day a visit falls on is the day at the house, not in UTC", () => {
    assert.equal(warrantyLocalDate("2026-10-13T01:00:00Z", NY), "2026-10-12")
    assert.equal(warrantyLocalDate("2026-10-13T01:00:00Z", "Asia/Tokyo"), "2026-10-13")
  })

  test("typed wall-clock times become the right instant on both sides of a clock change", () => {
    assert.equal(zonedWallTimeToUtc("2026-03-07T09:00", NY), "2026-03-07T14:00:00.000Z")
    assert.equal(zonedWallTimeToUtc("2026-03-09T09:00", NY), "2026-03-09T13:00:00.000Z")
    assert.equal(zonedWallTimeToUtc("2026-11-01T01:30", NY), "2026-11-01T05:30:00.000Z")
    assert.equal(zonedWallTimeToUtc("2026-11-02T09:00", NY), "2026-11-02T14:00:00.000Z")
    assert.equal(zonedStartOfDay("2026-11-01", NY), "2026-11-01T04:00:00.000Z")
  })

  test("a community zone beats the org's, and an unknown zone falls back instead of throwing", () => {
    assert.equal(resolveWarrantyTimeZone("America/Chicago", NY), "America/Chicago")
    assert.equal(resolveWarrantyTimeZone(null, "America/Denver"), "America/Denver")
    assert.equal(resolveWarrantyTimeZone("Mars/Olympus", undefined), NY)
  })
})

// ---------------------------------------------------------------------------
// Service: dispatch, completion and backcharges.
// ---------------------------------------------------------------------------

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const vendorBills = []
stubModule("@/lib/services/vendor-bills", {
  createProjectVendorCredit: async (input) => {
    const bill = { id: id(800 + vendorBills.length), org_id: ORG, company_id: input.companyId, bill_number: input.billNumber }
    vendorBills.push(bill)
    return bill
  },
  createProjectVendorBill: async ({ input }) => {
    const bill = { id: id(800 + vendorBills.length), org_id: ORG, company_id: input.company_id, bill_number: input.bill_number }
    vendorBills.push(bill)
    return bill
  },
})
const sentEmails = []
const sentNotifications = []
stubModule("@/lib/services/mailer", {
  escapeHtml: (value) => value,
  getOrgSenderEmail: () => "builder@example.test",
  renderStandardEmailLayout: () => "",
  renderEmailTemplate: async (element) => require("@react-email/components").render(element),
  sendEmail: async (email) => { sentEmails.push(email); return true },
})
stubModule("@/lib/services/notifications", { NotificationService: class { async createAndQueue(input) { sentNotifications.push(input) } } })
stubModule("@/lib/services/portal-links", {
  ensurePortalLink: async ({ portalType }) => `https://app.test/${portalType === "client" ? "p" : "s"}/token`,
  fetchCompanyContacts: async () => [{ id: "contact-trade", email: "crew@trade.test", full_name: "Crew" }],
  fetchContactEmail: async () => ({ email: "buyer@home.test", full_name: "Pat" }),
})

const {
  cancelWarrantyVisit,
  completeWarrantyVisit,
  confirmWarrantyVisitByBuyer,
  createWarrantyRequest,
  issueWarrantyBackcharge,
  rejectWarrantyVisitCompletion,
  requestWarrantyVisitRescheduleByBuyer,
  rescheduleWarrantyVisit,
  resolveWarrantyBackcharge,
  scheduleWarrantyVisit,
  updateWarrantyRequest,
} = freshRequire("lib/services/warranty-operations.ts")

const HOME = id(1)
const REQUEST = id(2)
const VISIT = id(3)
const TECH = id(4)
const TRADE = id(5)
const BACKCHARGE = id(6)
const BUYER = id(8)
const COMMUNITY_ID = id(21)
const PHOTO = id(7)
const SEEN = "2026-10-03T00:00:00+00:00"

function warrantyHarness(tables = {}, { rpc } = {}) {
  vendorBills.length = 0
  sentEmails.length = 0
  sentNotifications.length = 0
  const service = createServiceHarness({
    rpc,
    permissions: ["warranty.read", "warranty.write", "warranty.backcharge", "bill.write"],
    projects: [HOME],
    tables: {
      projects: [{ id: HOME, org_id: ORG, name: "Lot 12" }],
      warranty_requests: [{ id: REQUEST, org_id: ORG, project_id: HOME, title: "Leak under sink", status: "in_progress", requested_by: BUYER, created_at: SEEN, updated_at: SEEN, metadata: {} }],
      orgs: [{ id: ORG, name: "Acme Homes", slug: "acme", logo_url: null, time_zone: "America/New_York" }],
      lots: [{ id: id(20), org_id: ORG, project_id: HOME, community_id: COMMUNITY_ID, community: { time_zone: null } }],
      warranty_routing_rules: [],
      warranty_service_visits: [],
      warranty_backcharges: [],
      vendor_bills: vendorBills,
      files: [{ id: PHOTO, org_id: ORG, project_id: HOME, archived_at: null }],
      feature_flags: [],
      warranty_visit_completion_receipts: [],
      ...tables,
    },
  })
  // The stubs write where the service reads.
  service.db.vendor_bills = vendorBills
  return service
}

const visitRow = (overrides = {}) => ({
  id: VISIT, org_id: ORG, project_id: HOME, request_id: REQUEST, visit_number: 1, assignee_kind: "tech", assigned_user_id: TECH, assigned_company_id: null,
  window_start: "2026-10-12T14:00:00.000Z", window_end: "2026-10-12T16:00:00.000Z", status: "scheduled", metadata: {}, updated_at: SEEN, ...overrides,
})

describe("scheduleWarrantyVisit", () => {
  const booking = (overrides = {}) => ({ request_id: REQUEST, assignee_kind: "tech", assigned_user_id: TECH, window_start: "2026-10-12T15:00:00.000Z", window_end: "2026-10-12T17:00:00.000Z", ...overrides })

  test("a booking over a conflict the coordinator accepted is marked as a deliberate overlap", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow()] })
    await service.run(() => scheduleWarrantyVisit(booking({ allow_conflict: true, conflict_reason: "Two-person lift" })))
    assert.equal(service.db.warranty_service_visits[1].overlap_allowed, true)
    assert.equal(service.db.warranty_service_visits[1].metadata.overlap_reason, "Two-person lift")
    assert.equal(service.db.warranty_service_visits[1].metadata.overlap_with_visit_id, VISIT)

    const clear = warrantyHarness()
    await clear.run(() => scheduleWarrantyVisit(booking()))
    assert.equal(clear.db.warranty_service_visits[0].overlap_allowed, false)
  })

  test("overriding a conflict without saying why is refused before anything is written", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow()] })
    await assert.rejects(service.run(() => scheduleWarrantyVisit(booking({ allow_conflict: true }))), /Say why/)
    assert.deepEqual(service.writes("warranty_service_visits"), [])
  })

  test("the request date is the day at the house, not the day in UTC", async () => {
    // 9 pm in New York on 12 Oct is already 13 Oct in UTC.
    const service = warrantyHarness()
    await service.run(() => scheduleWarrantyVisit(booking({ window_start: "2026-10-13T01:00:00.000Z", window_end: "2026-10-13T02:00:00.000Z" })))
    assert.equal(service.db.warranty_requests[0].scheduled_date, "2026-10-12")
  })

  test("scheduling tells the homeowner and the trade the time at the house, with the way to confirm it", async () => {
    const service = warrantyHarness()
    await service.run(() => scheduleWarrantyVisit(booking({ assignee_kind: "trade", assigned_user_id: null, assigned_company_id: TRADE })))
    const buyer = sentEmails.find((email) => email.to.includes("buyer@home.test"))
    assert.match(buyer.html, /11:00 AM – 1:00 PM EDT/)
    assert.match(buyer.html, new RegExp(`https://app.test/p/token/warranty/visits/${service.db.warranty_service_visits[0].id}`))
    assert.ok(sentEmails.some((email) => email.to.includes("crew@trade.test")))
    assert.ok(service.events.some((event) => event.eventType === "warranty_request_dispatched"))
  })

  test("a booking the database refuses as a double-booking reads as one", async () => {
    const service = warrantyHarness()
    // Another coordinator booked the same window between the check and the insert.
    service.tamper("warranty_service_visits", (result) => ({ ...result, data: null, error: { code: "23P01", message: "conflicting key value violates exclusion constraint" } }), { on: "insert" })
    await assert.rejects(service.run(() => scheduleWarrantyVisit(booking())), /already booked/)
    assert.deepEqual(service.writes("warranty_requests"), [])
  })
})

describe("completing and verifying a visit", () => {
  const complete = (service, input) => service.run(() => completeWarrantyVisit({ visit_id: VISIT, outcome: "resolved", ...input }))
  const request = (service) => service.db.warranty_requests[0]

  test("an office resolution without a photo or sign-off waits for verification instead of closing", async () => {
    const bare = warrantyHarness({ warranty_service_visits: [visitRow()] })
    await complete(bare, {})
    assert.equal(request(bare).status, "in_progress")
    assert.equal(request(bare).metadata.pending_verification, true)

    const evidenced = warrantyHarness({ warranty_service_visits: [visitRow()], warranty_visit_photos: [] })
    await complete(evidenced, { photo_file_ids: [PHOTO] })
    assert.equal(request(evidenced).status, "resolved")
    assert.equal(request(evidenced).metadata.pending_verification, false)
  })

  test("sending a completion back reopens the request with the reason on the record", async () => {
    const service = warrantyHarness({
      warranty_service_visits: [visitRow({ status: "completed", outcome: "resolved" })],
      warranty_requests: [{ id: REQUEST, org_id: ORG, project_id: HOME, title: "Leak", status: "in_progress", created_at: SEEN, updated_at: SEEN, metadata: { pending_verification: true, completed_visit_id: VISIT } }],
    })
    await service.run(() => rejectWarrantyVisitCompletion(VISIT, "Still dripping at the trap"))
    assert.equal(request(service).status, "in_progress")
    assert.equal(request(service).metadata.pending_verification, false)
    assert.equal(request(service).metadata.rejection_reason, "Still dripping at the trap")
    assert.deepEqual(service.events.map((event) => event.eventType), ["warranty_visit_rejected"])
  })
})

describe("backcharges", () => {
  const backcharge = (overrides = {}) => ({
    id: BACKCHARGE, org_id: ORG, project_id: HOME, warranty_request_id: REQUEST, company_id: TRADE, commitment_id: null, cost_code_id: null,
    backcharge_number: 7, status: "draft", amount_cents: 450_00, recovered_cents: 0, reason: "Failed trap seal",
    cost_basis: [{ label: "Plumber callback", amount_cents: 450_00 }], vendor_credit_bill_id: null, metadata: { no_ap_history_confirmed: true },
    created_at: SEEN, updated_at: SEEN, ...overrides,
  })

  test("issuing twice at once creates one vendor credit", async () => {
    const service = warrantyHarness({ warranty_backcharges: [backcharge()] })
    const issue = () => service.run(() => issueWarrantyBackcharge({ backchargeId: BACKCHARGE }))
    const outcomes = await Promise.allSettled([issue(), issue()])
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1)
    assert.equal(vendorBills.length, 1)
    assert.equal(service.db.warranty_backcharges[0].status, "issued")
    assert.equal(service.db.warranty_backcharges[0].metadata.transition_claimed_at, undefined)
  })

  test("waiving twice at once reverses the credit once", async () => {
    const service = warrantyHarness({ warranty_backcharges: [backcharge({ status: "issued", vendor_credit_bill_id: id(799) })] })
    const waive = () => service.run(() => resolveWarrantyBackcharge({ backchargeId: BACKCHARGE, resolution: "waived", note: "Goodwill to the trade" }))
    const outcomes = await Promise.allSettled([waive(), waive()])
    assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1)
    assert.deepEqual(vendorBills.map((bill) => bill.bill_number), ["WB-7-R"])
  })

  test("a retry after an interrupted issue reuses the credit the first attempt created", async () => {
    const service = warrantyHarness({ warranty_backcharges: [backcharge()] })
    vendorBills.push({ id: id(790), org_id: ORG, company_id: TRADE, bill_number: "WB-7" })
    await service.run(() => issueWarrantyBackcharge({ backchargeId: BACKCHARGE }))
    assert.equal(vendorBills.length, 1)
    assert.equal(service.db.warranty_backcharges[0].vendor_credit_bill_id, id(790))
  })

  test("a failed credit releases the claim so the issue can be retried", async () => {
    const service = warrantyHarness({ warranty_backcharges: [backcharge()] })
    let failed = 0
    // The lookup for a credit an earlier attempt created fails, after the claim was taken.
    service.tamper("vendor_bills", (result, query) => (query.where.bill_number && !failed++ ? replies.error("bills unavailable")(result) : result), { on: "select" })
    await assert.rejects(service.run(() => issueWarrantyBackcharge({ backchargeId: BACKCHARGE })), /bills unavailable/)
    assert.equal(service.db.warranty_backcharges[0].metadata.transition_claimed_at, undefined)
    await service.run(() => issueWarrantyBackcharge({ backchargeId: BACKCHARGE }))
    assert.equal(service.db.warranty_backcharges[0].status, "issued")
  })
})

describe("moving and canceling a visit", () => {
  const confirmedVisit = () => visitRow({ status: "confirmed", confirmed_at: SEEN, buyer_confirmed_at: SEEN, assigned_user_id: TECH })
  const harness = () => warrantyHarness({ warranty_service_visits: [confirmedVisit()] })
  const move = { visit_id: VISIT, window_start: "2026-10-13T14:00:00.000Z", window_end: "2026-10-13T16:00:00.000Z", note: "Parts arrived early" }

  test("a reschedule tells the homeowner and the technician the new time and the old one, and records the move", async () => {
    const service = harness()
    await service.run(() => rescheduleWarrantyVisit(move))

    const buyer = sentEmails.find((email) => email.to.includes("buyer@home.test"))
    assert.match(buyer.subject, /moved/)
    assert.match(buyer.html, /10:00 AM – 12:00 PM EDT/)
    assert.match(buyer.html, /Previously/)
    assert.match(buyer.html, /Oct 12, 2026, 10:00 AM – 12:00 PM EDT/)
    assert.deepEqual(sentNotifications.map((note) => [note.userId, note.type]), [[TECH, "warranty_visit_rescheduled"]])
    const event = service.events.find((entry) => entry.eventType === "warranty_visit_rescheduled")
    assert.equal(event.payload.window_start, "2026-10-13T14:00:00.000Z")
    assert.equal(event.payload.previous_window_start, "2026-10-12T14:00:00.000Z")
    assert.deepEqual([event.payload.notices.buyer_emailed, event.payload.notices.tech_notified], [true, true])
    assert.equal(service.audits.at(-1).action, "update")
  })

  test("a moved visit needs the homeowner's confirmation again", async () => {
    const service = harness()
    await service.run(() => rescheduleWarrantyVisit(move))
    const visit = service.db.warranty_service_visits[0]
    assert.equal(visit.buyer_confirmed_at, null)
    assert.equal(visit.confirmed_at, null)
    assert.equal(visit.status, "scheduled")
  })

  test("a reschedule that lands on the same day at the house moves the request date with it", async () => {
    const service = harness()
    await service.run(() => rescheduleWarrantyVisit({ ...move, window_start: "2026-10-14T02:00:00.000Z", window_end: "2026-10-14T03:00:00.000Z" }))
    assert.equal(service.db.warranty_requests[0].scheduled_date, "2026-10-13")
  })

  test("canceling tells everyone who planned around the visit, and records it", async () => {
    const service = harness()
    await service.run(() => cancelWarrantyVisit(VISIT, "Homeowner resolved it themselves"))

    assert.match(sentEmails.find((email) => email.to.includes("buyer@home.test")).subject, /canceled/)
    assert.deepEqual(sentNotifications.map((note) => note.type), ["warranty_visit_canceled"])
    const event = service.events.find((entry) => entry.eventType === "warranty_visit_canceled")
    assert.equal(event.payload.reason, "Homeowner resolved it themselves")
    assert.equal(service.db.warranty_service_visits[0].status, "canceled")
  })

  test("a notice that cannot be delivered does not undo the change, and the event says nobody was told", async () => {
    const service = harness()
    service.tamper("orgs", replies.error("orgs unavailable"), { on: "select" })
    await service.run(() => cancelWarrantyVisit(VISIT))
    assert.equal(service.db.warranty_service_visits[0].status, "canceled")
    assert.equal(service.events.find((entry) => entry.eventType === "warranty_visit_canceled").payload.notices, null)
  })
})

describe("the homeowner's answer to an appointment", () => {
  const answer = (service, work) => service.run(work)
  const buyer = () => ({ orgId: ORG, projectId: HOME, contactId: BUYER, visitId: VISIT })

  test("confirming is recorded as an event and an audit row, and tells the technician", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow()] })
    const visit = await answer(service, () => confirmWarrantyVisitByBuyer(buyer()))
    assert.ok(visit.buyer_confirmed_at)
    assert.equal(visit.time_zone, "America/New_York")
    assert.deepEqual(visit.metadata, {})
    assert.equal(service.events.at(-1).eventType, "warranty_visit_buyer_confirmed")
    assert.equal(service.events.at(-1).payload.contact_id, BUYER)
    assert.equal(service.audits.at(-1).source, "buyer_portal")
    assert.deepEqual(sentNotifications.map((note) => [note.userId, note.type]), [[TECH, "warranty_visit_buyer_confirmed"]])
  })

  test("confirming twice answers once", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow()] })
    await answer(service, () => confirmWarrantyVisitByBuyer(buyer()))
    await answer(service, () => confirmWarrantyVisitByBuyer(buyer()))
    assert.equal(service.events.filter((event) => event.eventType === "warranty_visit_buyer_confirmed").length, 1)
  })

  test("asking for another time withdraws the confirmation and puts the ask in front of the owner", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow({ buyer_confirmed_at: SEEN })] })
    const visit = await answer(service, () => requestWarrantyVisitRescheduleByBuyer({ ...buyer(), note: "Mornings only" }))
    assert.equal(visit.buyer_confirmed_at, null)
    assert.equal(visit.buyer_reschedule_note, "Mornings only")
    assert.equal(service.events.at(-1).eventType, "warranty_visit_buyer_reschedule_requested")
    assert.equal(sentNotifications[0].type, "warranty_buyer_reschedule_requested")
    assert.match(sentNotifications[0].message, /Mornings only/)
  })

  test("a homeowner cannot answer for another home's visit, or for one that is finished", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow(), visitRow({ id: id(30), request_id: id(31), project_id: id(32), visit_number: 1 }), visitRow({ id: id(33), visit_number: 2, status: "completed" })] })
    await assert.rejects(answer(service, () => confirmWarrantyVisitByBuyer({ ...buyer(), visitId: id(30) })), /not found/)
    await assert.rejects(answer(service, () => confirmWarrantyVisitByBuyer({ ...buyer(), visitId: id(33) })), /no longer be changed/)
    assert.deepEqual(service.events, [])
  })

  test("a request for another time has to say what would work", async () => {
    const service = warrantyHarness({ warranty_service_visits: [visitRow()] })
    await assert.rejects(answer(service, () => requestWarrantyVisitRescheduleByBuyer({ ...buyer(), note: " " })), /what time works/)
    assert.deepEqual(service.writes("warranty_service_visits"), [])
  })
})

describe("routing a request to its owner", () => {
  const rule = (overrides = {}) => ({ id: id(40), org_id: ORG, name: "Emergencies", priority: 10, severity: "emergency", category: null, community_id: null, cost_code_id: null, assignee_kind: "tech", assigned_user_id: TECH, assigned_company_id: null, is_active: true, ...overrides })
  const intake = { project_id: HOME, title: "Burst pipe", severity: "emergency" }

  test("a new request goes to the owner its rule names, and the routing is on the record", async () => {
    const service = warrantyHarness({ warranty_routing_rules: [rule()], warranty_sla_targets: [], punch_items: [], warranty_request_photos: [], warranty_programs: [], warranty_coverage_terms: [], project_warranty_coverage: [] }, { rpc: { next_warranty_request_number: () => 2 } })
    const created = await service.run(() => createWarrantyRequest({ input: intake }))
    assert.equal(created.assigned_user_id, TECH)
    assert.equal(created.metadata.routing.source, "rule")
    assert.equal(created.metadata.routing.rule_id, id(40))
    assert.ok(service.events.some((event) => event.eventType === "warranty_request_routed"))
    assert.deepEqual(sentNotifications.map((note) => [note.userId, note.type]), [[TECH, "warranty_request_routed"]])
  })

  test("a request no rule matches is left for manual triage", async () => {
    const service = warrantyHarness({ warranty_routing_rules: [rule({ severity: "routine_60" })], warranty_sla_targets: [], punch_items: [], warranty_request_photos: [], warranty_programs: [], warranty_coverage_terms: [], project_warranty_coverage: [] }, { rpc: { next_warranty_request_number: () => 2 } })
    const created = await service.run(() => createWarrantyRequest({ input: intake }))
    assert.equal(created.assigned_user_id, null)
    assert.equal(service.events.some((event) => event.eventType === "warranty_request_routed"), false)
  })

  test("taking a routed request elsewhere needs a reason, and the override is recorded against the rule", async () => {
    const routed = { id: REQUEST, org_id: ORG, project_id: HOME, title: "Leak", status: "open", assigned_user_id: TECH, created_at: SEEN, updated_at: SEEN, metadata: { routing: { source: "rule", rule_id: id(40), rule_name: "Emergencies" } } }
    const service = warrantyHarness({ warranty_requests: [routed] })
    const other = id(50)
    await assert.rejects(service.run(() => updateWarrantyRequest({ requestId: REQUEST, input: { assigned_user_id: other } })), /not going to the routed owner/)
    assert.deepEqual(service.writes("warranty_requests"), [])

    const updated = await service.run(() => updateWarrantyRequest({ requestId: REQUEST, input: { assigned_user_id: other, routing_override_reason: "Tech is on leave" } }))
    assert.equal(updated.metadata.routing.source, "manual")
    assert.equal(updated.metadata.routing.overridden_rule_id, id(40))
    assert.equal(updated.metadata.routing.override_reason, "Tech is on leave")
    const event = service.events.find((entry) => entry.eventType === "warranty_request_routing_overridden")
    assert.equal(event.payload.reason, "Tech is on leave")
  })

  test("reassigning a request nobody routed needs no reason, but is still recorded", async () => {
    const service = warrantyHarness()
    await service.run(() => updateWarrantyRequest({ requestId: REQUEST, input: { assigned_user_id: id(50) } }))
    assert.ok(service.events.some((entry) => entry.eventType === "warranty_request_reassigned"))
  })
})
