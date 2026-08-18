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
  buildGeneratedPoNumber,
  findExpiringAgreements,
  generationSourceKey,
  nextGeneratedPoSequence,
  selectMissingLines,
} = require("../lib/services/po-generation")
const { completedWeekWindows, summarizeVarianceByOrg } = require("../lib/services/purchasing-maintenance")

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
// Scoped incremental regeneration
// ---------------------------------------------------------------------------

const resolvedLine = (sourceId, sourceKind = "takeoff_line") => ({ sourceKind, sourceId, totalCents: 100 })

test("a scoped commit creates only the lines no commitment covers yet", () => {
  const lines = [resolvedLine("takeoff-1"), resolvedLine("takeoff-2"), resolvedLine("selection-1", "option")]
  const covered = [generationSourceKey("takeoff_line", "takeoff-1"), generationSourceKey("option", "selection-1")]
  assert.deepEqual(selectMissingLines(lines, covered).map((line) => line.sourceId), ["takeoff-2"])
  assert.deepEqual(selectMissingLines(lines, []).map((line) => line.sourceId), ["takeoff-1", "takeoff-2", "selection-1"])
})

test("re-running a scoped commit after every line landed creates nothing", () => {
  // This is what makes resolve-then-mark safe to retry: the second attempt after
  // a partial failure adds no duplicate purchase order.
  const lines = [resolvedLine("takeoff-1"), resolvedLine("takeoff-2")]
  const covered = lines.map((line) => generationSourceKey(line.sourceKind, line.sourceId))
  assert.deepEqual(selectMissingLines(lines, covered), [])
})

test("source keys separate takeoff lines from options with the same id", () => {
  assert.notEqual(generationSourceKey("takeoff_line", "shared"), generationSourceKey("option", "shared"))
  const lines = [resolvedLine("shared"), resolvedLine("shared", "option")]
  assert.deepEqual(
    selectMissingLines(lines, [generationSourceKey("takeoff_line", "shared")]).map((line) => line.sourceKind),
    ["option"],
  )
})

// ---------------------------------------------------------------------------
// Generated purchase-order numbers
// ---------------------------------------------------------------------------

test("lot 42 in two communities does not produce the same purchase-order number", () => {
  const north = buildGeneratedPoNumber({ communityCode: "NRD", lotNumber: "42" }, 1)
  const south = buildGeneratedPoNumber({ communityCode: "STH", lotNumber: "42" }, 1)
  assert.notEqual(north, south)
  assert.equal(north, "PO-NRD-42-01")
  assert.equal(south, "PO-STH-42-01")
})

test("regeneration continues the sequence instead of reissuing numbers", () => {
  const firstRun = [1, 2, 3].map((sequence) => buildGeneratedPoNumber({ communityCode: "NRD", lotNumber: "42" }, sequence))
  const next = nextGeneratedPoSequence(firstRun)
  assert.equal(next, 4)
  const secondRun = [next, next + 1].map((sequence) => buildGeneratedPoNumber({ communityCode: "NRD", lotNumber: "42" }, sequence))
  const all = [...firstRun, ...secondRun]
  assert.equal(new Set(all).size, all.length)
  assert.deepEqual(secondRun, ["PO-NRD-42-04", "PO-NRD-42-05"])
})

test("purchase-order numbering survives blocks, missing codes, and untidy input", () => {
  assert.equal(buildGeneratedPoNumber({ communityCode: "NRD", lotNumber: "42", block: "b" }, 7), "PO-NRD-42-BB-07")
  assert.equal(buildGeneratedPoNumber({ communityName: "Sunset Ridge", lotNumber: "42" }, 1), "PO-SUNSET-RIDGE-42-01")
  assert.equal(buildGeneratedPoNumber({ lotNumber: null }, 1), "PO-COMM-LOT-01")
  assert.equal(nextGeneratedPoSequence([]), 1)
  assert.equal(nextGeneratedPoSequence([null, "PO-NRD-42-09", "hand-typed"]), 10)
  assert.equal(nextGeneratedPoSequence(["PO-NRD-42-02", "PO-NRD-42-11"]), 12)
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
