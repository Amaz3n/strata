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
stubModule("@/lib/services/mailer", {
  escapeHtml: (value) => value,
  getOrgSenderEmail: () => "builder@example.test",
  renderStandardEmailLayout: () => "",
  sendEmail: async () => {},
})
stubModule("@/lib/services/notifications", { NotificationService: class { async createAndQueue() {} } })
stubModule("@/lib/services/portal-links", { ensurePortalLink: async () => null, fetchCompanyContacts: async () => [], fetchContactEmail: async () => null })

const {
  completeWarrantyVisit,
  issueWarrantyBackcharge,
  rejectWarrantyVisitCompletion,
  resolveWarrantyBackcharge,
  scheduleWarrantyVisit,
} = freshRequire("lib/services/warranty-operations.ts")

const HOME = id(1)
const REQUEST = id(2)
const VISIT = id(3)
const TECH = id(4)
const TRADE = id(5)
const BACKCHARGE = id(6)
const PHOTO = id(7)
const SEEN = "2026-10-03T00:00:00+00:00"

function warrantyHarness(tables = {}) {
  vendorBills.length = 0
  const service = createServiceHarness({
    permissions: ["warranty.read", "warranty.write", "warranty.backcharge", "bill.write"],
    projects: [HOME],
    tables: {
      projects: [{ id: HOME, org_id: ORG, name: "Lot 12" }],
      warranty_requests: [{ id: REQUEST, org_id: ORG, project_id: HOME, title: "Leak under sink", status: "in_progress", created_at: SEEN, updated_at: SEEN, metadata: {} }],
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
    await service.run(() => scheduleWarrantyVisit(booking({ allow_conflict: true })))
    assert.equal(service.db.warranty_service_visits[1].overlap_allowed, true)

    const clear = warrantyHarness()
    await clear.run(() => scheduleWarrantyVisit(booking()))
    assert.equal(clear.db.warranty_service_visits[0].overlap_allowed, false)
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
