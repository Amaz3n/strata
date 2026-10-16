require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const {
  PRICE_BOOK_PAGE_SIZE,
  collectPagedRows,
  findAmbiguousAgreementScopes,
  findCoverageGaps,
  loadPriceAgreementCandidates,
} = require("../lib/services/price-book")
const {
  claimedCompletionLineIds,
  findConflictingCompletion,
  hasWholeOrderClaim,
} = require("../lib/services/po-completions")
const {
  findExpiringAgreements,
  generatedPoNumberPrefix,
  generationSourceKey,
} = require("../lib/services/po-generation")
const { completedWeekWindows, summarizeVarianceByOrg } = require("../lib/services/purchasing-maintenance")
const { classifyPoPosition, poRemainingCents, poRevisedCents } = require("../lib/purchasing/po-position")
const { varianceAnalysisCsv } = require("../lib/services/reports/variance-analysis")

const migration = (name) => fs.readFileSync(path.resolve(__dirname, "../supabase/migrations", name), "utf8")

const agreement = (overrides = {}) => ({
  id: "agreement-a", company_id: "vendor-a", cost_code_id: "cc-1", cost_type: null,
  division_id: null, community_id: null, house_plan_id: null, house_plan_version_id: null,
  pricing_kind: "unit", uom: "ea", unit_cost_cents: 1000, lump_sum_cents: null,
  scope_of_work: null, effective_from: "2026-01-01", effective_to: null, status: "active",
  ...overrides,
})

/** Minimal PostgREST-shaped stub: records filters, honours `.range()`. */
function agreementClient(rows, log = {}) {
  return {
    from(table) {
      log.table = table
      const state = { statuses: null, costCodeIds: null }
      log.state = state
      const chain = {
        select() { return chain },
        eq() { return chain },
        in(column, values) {
          if (column === "status") state.statuses = values
          if (column === "cost_code_id") state.costCodeIds = values
          return chain
        },
        order() { return chain },
        range(from, to) {
          log.pages = (log.pages ?? 0) + 1
          const matching = rows.filter((row) =>
            (!state.costCodeIds || state.costCodeIds.includes(row.cost_code_id))
            && (!state.statuses || state.statuses.includes(row.status)))
          return Promise.resolve({ data: matching.slice(from, to + 1), error: null })
        },
      }
      return chain
    },
  }
}

// ---------------------------------------------------------------------------
// Price-agreement loading: no silent truncation
// ---------------------------------------------------------------------------

test("paged reads return every row instead of stopping at the PostgREST page cap", async () => {
  const rows = Array.from({ length: 2500 }, (_, index) => ({ id: `row-${index}` }))
  const collected = await collectPagedRows({
    label: "rows",
    fetchPage: (from, to) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
  })
  assert.equal(collected.length, 2500)
  assert.equal(collected[0].id, "row-0")
  assert.equal(collected.at(-1).id, "row-2499")
})

test("paged reads stop with a clear error rather than truncating an implausible set", async () => {
  await assert.rejects(
    () => collectPagedRows({
      label: "price agreements",
      cap: 2000,
      fetchPage: (from, to) => Promise.resolve({ data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })), error: null }),
    }),
    /Refusing to read more than 2000 price agreements/,
  )
})

test("paged reads surface the database error instead of returning a short set", async () => {
  await assert.rejects(
    () => collectPagedRows({ label: "rows", fetchPage: () => Promise.resolve({ data: null, error: { message: "boom" } }) }),
    /Failed to load rows: boom/,
  )
})

test("price-agreement candidates page past 1000 rows and drop only unresolvable statuses", async () => {
  // A repriced book leaves a superseded row behind every change, which is exactly
  // how the candidate set used to blow past the 1000-row cap and price work wrong.
  const live = Array.from({ length: 1400 }, (_, index) => agreement({ id: `live-${index}`, status: "active" }))
  const dead = Array.from({ length: 4000 }, (_, index) => agreement({ id: `dead-${index}`, status: "superseded" }))
  const log = {}
  const candidates = await loadPriceAgreementCandidates({
    supabase: agreementClient([...dead.slice(0, 2000), ...live, ...dead.slice(2000)], log),
    orgId: "org-1",
    costCodeIds: ["cc-1", "cc-1"],
  })
  assert.equal(candidates.length, 1400)
  assert.deepEqual(log.state.statuses, ["active", "expired"])
  assert.deepEqual(log.state.costCodeIds, ["cc-1"])
  assert.ok(log.pages > 1, "expected more than one page to be read")
  assert.equal(PRICE_BOOK_PAGE_SIZE, 1000)
})

test("price-agreement candidates skip the query entirely when nothing needs pricing", async () => {
  const log = {}
  assert.deepEqual(await loadPriceAgreementCandidates({ supabase: agreementClient([], log), orgId: "org-1", costCodeIds: [] }), [])
  assert.equal(log.pages, undefined)
})

// ---------------------------------------------------------------------------
// Price-book health: same rules the generator uses
// ---------------------------------------------------------------------------

test("ambiguity is counted only where the resolver would actually raise it", () => {
  const tied = [
    agreement({ id: "a1", company_id: "vendor-a" }),
    agreement({ id: "a2", company_id: "vendor-b" }),
  ]
  assert.deepEqual(
    findAmbiguousAgreementScopes(tied, "2026-08-17").map((entry) => entry.agreementIds),
    [["a1", "a2"]],
  )

  // A more specific agreement wins outright, so the pair below it is not an
  // exception the generator will ever raise — the old duplicate-signature count
  // ignored cost_type and reported this as an overlap.
  const outranked = [...tied, agreement({ id: "a3", company_id: "vendor-c", cost_type: "material" })]
  assert.deepEqual(findAmbiguousAgreementScopes(outranked, "2026-08-17"), [])
})

test("agreements outside their effective window are not ambiguous, they are expired", () => {
  const lapsed = [
    agreement({ id: "a1", company_id: "vendor-a", effective_to: "2026-06-30" }),
    agreement({ id: "a2", company_id: "vendor-b", effective_to: "2026-06-30" }),
  ]
  assert.deepEqual(findAmbiguousAgreementScopes(lapsed, "2026-08-17"), [])
  assert.equal(findAmbiguousAgreementScopes(lapsed, "2026-05-01").length, 1)
})

test("coverage gaps are cost codes a community cannot price at all", () => {
  const candidatesByCostCode = new Map([
    ["cc-covered", [agreement({ id: "c1", cost_code_id: "cc-covered", community_id: "community-1" })]],
    ["cc-elsewhere", [agreement({ id: "c2", cost_code_id: "cc-elsewhere", community_id: "community-2" })]],
    ["cc-wrong-unit", [agreement({ id: "c3", cost_code_id: "cc-wrong-unit", uom: "lf" })]],
    ["cc-lapsed", [agreement({ id: "c4", cost_code_id: "cc-lapsed", effective_to: "2026-01-31" })]],
  ])
  const plans = [{ housePlanId: "plan-1", housePlanVersionId: "version-1" }]
  const demand = (costCodeId) => ({ communityId: "community-1", divisionId: "division-1", costCodeId, plans })
  const gaps = findCoverageGaps({
    demands: ["cc-covered", "cc-elsewhere", "cc-wrong-unit", "cc-lapsed", "cc-missing"].map(demand),
    candidatesByCostCode,
    asOfDate: "2026-08-17",
  })
  // A wrong unit is a pricing defect, not a hole in the book.
  assert.deepEqual(gaps.map((gap) => gap.costCodeId), ["cc-elsewhere", "cc-lapsed", "cc-missing"])
})

test("a plan-scoped agreement covers the community that offers that plan", () => {
  const candidatesByCostCode = new Map([["cc-1", [agreement({ house_plan_id: "plan-1" })]]])
  const covered = findCoverageGaps({
    demands: [{ communityId: "community-1", divisionId: null, costCodeId: "cc-1", plans: [{ housePlanId: "plan-1", housePlanVersionId: null }] }],
    candidatesByCostCode, asOfDate: "2026-08-17",
  })
  assert.deepEqual(covered, [])
  const uncovered = findCoverageGaps({
    demands: [{ communityId: "community-1", divisionId: null, costCodeId: "cc-1", plans: [{ housePlanId: "plan-2", housePlanVersionId: null }] }],
    candidatesByCostCode, asOfDate: "2026-08-17",
  })
  assert.deepEqual(uncovered, [{ communityId: "community-1", costCodeId: "cc-1" }])
})

// ---------------------------------------------------------------------------
// Completions: one claim per purchase-order line
// ---------------------------------------------------------------------------

const completion = (overrides = {}) => ({ id: "completion-1", status: "reported", commitment_line_ids: null, ...overrides })

test("a second completion may not claim lines another completion already covers", () => {
  const existing = [completion({ id: "first", status: "verified", commitment_line_ids: ["line-1", "line-2"] })]
  assert.deepEqual(
    findConflictingCompletion({ requestedLineIds: ["line-1", "line-2"], existing }),
    { completionId: "first", lineIds: ["line-1", "line-2"] },
  )
  assert.deepEqual(
    findConflictingCompletion({ requestedLineIds: ["line-2", "line-3"], existing }),
    { completionId: "first", lineIds: ["line-2"] },
  )
  assert.equal(findConflictingCompletion({ requestedLineIds: ["line-3", "line-4"], existing }), null)
})

test("a whole-purchase-order completion collides with everything in both directions", () => {
  const wholeOrder = [completion({ id: "first", status: "billed", commitment_line_ids: null })]
  assert.equal(findConflictingCompletion({ requestedLineIds: ["line-9"], existing: wholeOrder }).completionId, "first")
  const partial = [completion({ id: "first", status: "approved", commitment_line_ids: ["line-1"] })]
  assert.equal(findConflictingCompletion({ requestedLineIds: null, existing: partial }).completionId, "first")
})

test("two forty-percent completions over identical lines cannot both stand", () => {
  // The aggregate revised-total check inside approve_po_completion passes both;
  // the per-line guard is the only thing that stops the double bill.
  const existing = [completion({ id: "first", status: "approved", commitment_line_ids: ["line-1", "line-2"] })]
  assert.notEqual(findConflictingCompletion({ requestedLineIds: ["line-1", "line-2"], existing }), null)
})

test("rejected and void completions release their lines so the trade can re-report", () => {
  const existing = [
    completion({ id: "first", status: "rejected", commitment_line_ids: ["line-1", "line-2"] }),
    completion({ id: "second", status: "void", commitment_line_ids: null }),
  ]
  assert.equal(findConflictingCompletion({ requestedLineIds: ["line-1", "line-2"], existing }), null)
  assert.equal(findConflictingCompletion({ requestedLineIds: null, existing }), null)
  assert.equal(claimedCompletionLineIds(existing).size, 0)
  assert.equal(hasWholeOrderClaim(existing), false)
})

test("a variance-order completion claims no PO line, and no variance order is billed twice", () => {
  const billed = [completion({ id: "first", status: "billed", commitment_line_ids: null, change_order_ids: ["vpo-1"] })]
  assert.equal(findConflictingCompletion({ requestedLineIds: [], requestedChangeOrderIds: ["vpo-2"], existing: billed }), null)
  assert.equal(findConflictingCompletion({ requestedLineIds: [], requestedChangeOrderIds: ["vpo-1", "vpo-2"], existing: billed }).completionId, "first")
  const vpoOnly = [completion({ id: "second", status: "verified", commitment_line_ids: [], change_order_ids: ["vpo-3"] })]
  assert.equal(findConflictingCompletion({ requestedLineIds: null, existing: vpoOnly }), null)
})

test("live completions report exactly which lines are still reportable", () => {
  const existing = [
    completion({ id: "first", status: "verified", commitment_line_ids: ["line-1"] }),
    completion({ id: "second", status: "rejected", commitment_line_ids: ["line-2"] }),
  ]
  assert.deepEqual(Array.from(claimedCompletionLineIds(existing)), ["line-1"])
  assert.equal(hasWholeOrderClaim(existing), false)
  assert.equal(hasWholeOrderClaim([completion({ status: "reported", commitment_line_ids: null })]), true)
})

// ---------------------------------------------------------------------------
// Generated purchase-order numbers
// ---------------------------------------------------------------------------

test("source keys separate takeoff lines from options with the same id", () => {
  assert.notEqual(generationSourceKey("takeoff_line", "shared"), generationSourceKey("option", "shared"))
})

test("lot 42 in two communities does not produce the same purchase-order prefix", () => {
  const north = generatedPoNumberPrefix({ communityCode: "NRD", lotNumber: "42" })
  const south = generatedPoNumberPrefix({ communityCode: "STH", lotNumber: "42" })
  assert.notEqual(north, south)
  assert.equal(north, "PO-NRD-42")
  assert.equal(south, "PO-STH-42")
})

test("purchase-order prefixes survive blocks, missing codes, and untidy input", () => {
  assert.equal(generatedPoNumberPrefix({ communityCode: "NRD", lotNumber: "42", block: "b" }), "PO-NRD-42-BB")
  assert.equal(generatedPoNumberPrefix({ communityName: "Sunset Ridge", lotNumber: "42" }), "PO-SUNSET-RIDGE-42")
  assert.equal(generatedPoNumberPrefix({ lotNumber: null }), "PO-COMM-LOT")
})

// ---------------------------------------------------------------------------
// Expiring-agreement pre-flight warning
// ---------------------------------------------------------------------------

const pricedLine = (agreementId) => ({
  agreementId, companyId: "vendor-a", companyName: "Vendor A", costCodeId: "cc-1", description: "Framing",
})

test("generation warns about agreements lapsing inside the lead window", () => {
  const warnings = findExpiringAgreements({
    lines: [pricedLine("soon"), pricedLine("soon"), pricedLine("later"), pricedLine("open"), pricedLine("gone")],
    agreementEndsById: new Map([
      ["soon", "2026-08-24"], ["later", "2026-12-01"], ["open", null], ["gone", "2026-08-01"],
    ]),
    asOfDate: "2026-08-17",
    leadDays: 30,
  })
  assert.deepEqual(warnings.map((warning) => warning.agreementId), ["soon"])
  assert.equal(warnings[0].daysRemaining, 7)
})

test("expiry warnings sort by urgency and stay quiet with a short lead window", () => {
  const agreementEndsById = new Map([["a", "2026-08-27"], ["b", "2026-08-19"]])
  const lines = [pricedLine("a"), pricedLine("b")]
  assert.deepEqual(
    findExpiringAgreements({ lines, agreementEndsById, asOfDate: "2026-08-17", leadDays: 30 }).map((w) => w.agreementId),
    ["b", "a"],
  )
  assert.deepEqual(
    findExpiringAgreements({ lines, agreementEndsById, asOfDate: "2026-08-17", leadDays: 3 }).map((w) => w.agreementId),
    ["b"],
  )
})

// ---------------------------------------------------------------------------
// Weekly variance digest
// ---------------------------------------------------------------------------

test("the digest window is any completed week, not whichever day the cron lands on", () => {
  const weekStarts = new Set()
  for (let day = 17; day <= 23; day += 1) {
    const windows = completedWeekWindows(new Date(Date.UTC(2026, 7, day, 12, 50)))
    assert.equal(windows.length, 4)
    weekStarts.add(windows[0].weekStart)
  }
  // Every run inside one week agrees on which week is the one to report.
  assert.equal(weekStarts.size, 1)
})

test("digest windows are whole, non-overlapping, most-recent-first weeks", () => {
  const windows = completedWeekWindows(new Date(Date.UTC(2026, 7, 20, 12, 50)), 3)
  assert.equal(windows.length, 3)
  for (const window of windows) {
    assert.equal(new Date(`${window.weekStart}T00:00:00Z`).getUTCDay(), 1, "weeks start on Monday")
    const span = (Date.parse(`${window.weekEndExclusive}T00:00:00Z`) - Date.parse(`${window.weekStart}T00:00:00Z`)) / 86_400_000
    assert.equal(span, 7)
  }
  assert.ok(windows[0].weekStart > windows[1].weekStart)
  assert.equal(windows[0].weekStart, windows[1].weekEndExclusive)
  // The week in progress is never reported.
  assert.ok(windows[0].weekEndExclusive <= "2026-08-20")
})

test("a missed run is caught up rather than skipped forever", () => {
  const windows = completedWeekWindows(new Date(Date.UTC(2026, 7, 20)), 4)
  assert.equal(windows.length, 4)
  assert.equal(new Set(windows.map((window) => window.weekStart)).size, 4)
})

test("variance totals are absolute and grouped per organization", () => {
  const totals = summarizeVarianceByOrg([
    { org_id: "org-1", total_cents: 5000 },
    { org_id: "org-1", total_cents: -2000 },
    { org_id: "org-2", total_cents: "1500" },
    { org_id: "org-2", total_cents: null },
  ])
  assert.deepEqual(totals.get("org-1"), { count: 2, cents: 7000 })
  assert.deepEqual(totals.get("org-2"), { count: 2, cents: 1500 })
})

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

test("the completion overlap guard is enforced at write time and at approval", () => {
  const sql = migration("20260817120000_po_completion_line_overlap_guard.sql")
  assert.match(sql, /create trigger po_completions_no_line_overlap/)
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(new\.commitment_id::text, 0\)\)/)
  assert.match(sql, /other\.commitment_line_ids && new\.commitment_line_ids/)
  assert.match(sql, /other\.commitment_line_ids && v_completion\.commitment_line_ids/)
  assert.match(sql, /already billed by completion/)
  // Rejected and void completions must stay re-reportable.
  assert.match(sql, /new\.status not in \('reported', 'verified', 'approved', 'billed'\)/)
  assert.match(sql, /revoke all on function public\.approve_po_completion\(uuid, uuid, uuid\) from public, anon, authenticated;/)
})

test("PO generation serializes per project and cannot reissue a number", () => {
  const sql = migration("20260817120100_po_generation_serialization.sql")
  assert.match(sql, /perform pg_advisory_xact_lock\(hashtextextended\(p_org_id::text \|\| ':' \|\| v_run\.project_id::text, 0\)\)/)
  assert.match(sql, /create unique index if not exists po_generation_runs_commit_fingerprint_uidx/)
  assert.match(sql, /create unique index if not exists commitments_generated_po_number_uidx/)
  assert.match(sql, /metadata->>'source' = 'po_generation'/)
  assert.match(sql, /revoke all on function public\.run_po_generation_commit\(uuid, uuid, jsonb\) from public, anon, authenticated;/)
  const body = sql.slice(sql.indexOf("function public.run_po_generation_commit"))
  assert.ok(
    body.indexOf("pg_advisory_xact_lock") < body.indexOf("v_prior_run_id := nullif"),
    "the lock must be taken before the prior-run delete-and-recreate decision",
  )
})

test("price-book imports and the bid-package constraint backlog are covered", () => {
  assert.match(
    migration("20260817120200_price_agreement_import_key_unique.sql"),
    /create unique index if not exists vendor_price_agreements_import_key_uidx/,
  )
  const validate = migration("20260817120300_validate_bid_package_award_target.sql")
  assert.match(validate, /validate constraint bid_packages_award_target_context/)
  // Both constraints are validated now. `bid_packages_parent_context` had two
  // violating rows — leftovers from testing prospect-to-project conversion,
  // each already pointing at a real project — so the migration clears the stale
  // prospect pointer first. The cleanup must stay scoped to rows carrying BOTH
  // pointers, or a legitimate prospect-only bid package would lose its parent.
  assert.match(validate, /validate constraint bid_packages_parent_context/)
  assert.match(validate, /set prospect_id = null/)
  assert.match(validate, /where project_id is not null\s*\n\s*and prospect_id is not null/)
})

// ---------------------------------------------------------------------------
// Purchase-order positions and the variance export
// ---------------------------------------------------------------------------

const position = (overrides = {}) => ({
  commitmentId: "po-1", projectId: "home-1", title: "Framing", contractNumber: null, companyId: null, status: "approved",
  divisionId: null, communityId: null, payOnPo: true, originalCents: 100_000, approvedVpoCents: 20_000, pendingVpoCount: 0,
  billedCents: 120_000, paidCents: 60_000, retainageHeldCents: 0, completionBilledCents: 120_000, openCompletionCount: 0,
  unclaimedVpoCents: 0, ...overrides,
})

test("a purchase order that reconciles raises nothing, and the revised total includes approved VPOs", () => {
  assert.deepEqual(classifyPoPosition(position()), [])
  assert.equal(poRevisedCents(position()), 120_000)
  assert.equal(poRemainingCents(position({ billedCents: 50_000 })), 70_000)
})

test("each way the books can disagree with a purchase order is named once, with its amount", () => {
  assert.deepEqual(classifyPoPosition(position({ billedCents: 130_000, completionBilledCents: 130_000 })), [{ kind: "overbilled", cents: 10_000 }])
  assert.deepEqual(classifyPoPosition(position({ paidCents: 125_000 })), [{ kind: "paid_exceeds_billed", cents: 5_000 }])
  assert.deepEqual(classifyPoPosition(position({ completionBilledCents: 100_000 })), [{ kind: "billed_without_completion", cents: 20_000 }])
  assert.deepEqual(classifyPoPosition(position({ unclaimedVpoCents: 20_000 })), [{ kind: "vpo_unbilled", cents: 20_000 }])
})

test("completion rules apply only where pay-on-PO does", () => {
  assert.deepEqual(classifyPoPosition(position({ payOnPo: false, completionBilledCents: 0, unclaimedVpoCents: 20_000 })), [])
})

test("the variance export states its period and scope and cannot be read as a formula", () => {
  const rows = [{ dimension: "vendor", dimension_id: "v", dimension_label: "=HYPERLINK(\"x\")", net_variance_cents: 12_345, absolute_variance_cents: 12_345, incidence: 1, direct_cost_budget_cents: 100_000, variance_rate: 0.12345 }]
  const csv = varianceAnalysisCsv(rows, { startDate: "2026-09-01", endDate: "2026-09-30", scopeLabel: "North" })
  assert.match(csv, /^Variance analysis,\nPeriod,2026-09-01 to 2026-09-30\nScope,North\n\nDimension,Group,/)
  assert.match(csv, /'=HYPERLINK/)
  assert.match(csv, /123\.45,123\.45,1,1000\.00,12\.35%/)
})
