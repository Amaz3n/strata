require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  agreementLocksStructuralOptions,
  describeSelectionChange,
  isSelectionPastCutoff,
  planPackageSelection,
  planSelectionVarianceOrders,
} = require("../lib/selections/selection-variance")
const { vpoApprovalBlockReason } = require("../lib/financials/vpo-approval-thresholds")
const { aggregateVarianceFacts } = require("../lib/services/reports/variance-analysis")

const COUNTERTOP_PO = { commitmentId: "po-countertop", companyId: "co-stone" }
const TRIM_PO = { commitmentId: "po-trim", companyId: "co-trim" }

function costCodeIndex(entries) {
  return new Map(entries)
}

function change(overrides) {
  return {
    selection_id: "sel-1",
    cost_code_id: "cc-countertop",
    cost_delta_cents: 120_000,
    category_name: "Kitchen countertop",
    option_name: "Level 4 granite",
    ...overrides,
  }
}

// --- Fix 1: design studio → VPO fan-out ------------------------------------

test("a post-cutoff upgrade routes its cost delta onto the purchase order that owns the cost code", () => {
  const { orders, unrouted } = planSelectionVarianceOrders({
    changes: [change({})],
    commitmentByCostCode: costCodeIndex([["cc-countertop", COUNTERTOP_PO]]),
  })
  assert.equal(unrouted.length, 0)
  assert.equal(orders.length, 1)
  assert.equal(orders[0].commitment_id, "po-countertop")
  assert.equal(orders[0].company_id, "co-stone")
  assert.equal(orders[0].total_cents, 120_000)
  assert.deepEqual(orders[0].selection_ids, ["sel-1"])
  assert.equal(orders[0].lines[0].description, "Kitchen countertop — Level 4 granite")
  assert.equal(orders[0].lines[0].unit_cost_cents, 120_000)
})

test("deltas sharing one purchase order collapse into a single variance order", () => {
  const { orders } = planSelectionVarianceOrders({
    changes: [
      change({ selection_id: "sel-1", cost_delta_cents: 120_000 }),
      change({ selection_id: "sel-2", cost_code_id: "cc-backsplash", cost_delta_cents: 30_000, category_name: "Backsplash", option_name: "Subway tile" }),
    ],
    commitmentByCostCode: costCodeIndex([
      ["cc-countertop", COUNTERTOP_PO],
      ["cc-backsplash", COUNTERTOP_PO],
    ]),
  })
  assert.equal(orders.length, 1)
  assert.equal(orders[0].total_cents, 150_000)
  assert.equal(orders[0].lines.length, 2)
  assert.deepEqual(orders[0].selection_ids, ["sel-1", "sel-2"])
})

test("different purchase orders get their own variance order", () => {
  const { orders } = planSelectionVarianceOrders({
    changes: [
      change({ selection_id: "sel-1" }),
      change({ selection_id: "sel-2", cost_code_id: "cc-trim", cost_delta_cents: -25_000 }),
    ],
    commitmentByCostCode: costCodeIndex([
      ["cc-countertop", COUNTERTOP_PO],
      ["cc-trim", TRIM_PO],
    ]),
  })
  assert.deepEqual(orders.map((order) => order.commitment_id).sort(), ["po-countertop", "po-trim"])
  assert.equal(orders.find((order) => order.commitment_id === "po-trim").total_cents, -25_000)
})

test("a downgrade produces a negative variance order rather than being dropped", () => {
  const { orders, unrouted } = planSelectionVarianceOrders({
    changes: [change({ cost_delta_cents: -80_000 })],
    commitmentByCostCode: costCodeIndex([["cc-countertop", COUNTERTOP_PO]]),
  })
  assert.equal(unrouted.length, 0)
  assert.equal(orders[0].total_cents, -80_000)
})

test("a zero-cost swap creates nothing at all", () => {
  const { orders, unrouted } = planSelectionVarianceOrders({
    changes: [change({ cost_delta_cents: 0 })],
    commitmentByCostCode: costCodeIndex([["cc-countertop", COUNTERTOP_PO]]),
  })
  assert.deepEqual(orders, [])
  assert.deepEqual(unrouted, [])
})

test("a delta with no purchase order behind its cost code is reported, never silently dropped", () => {
  const { orders, unrouted } = planSelectionVarianceOrders({
    changes: [
      change({ selection_id: "sel-1", cost_code_id: "cc-unbought" }),
      change({ selection_id: "sel-2", cost_code_id: null, cost_delta_cents: 40_000 }),
    ],
    commitmentByCostCode: costCodeIndex([["cc-countertop", COUNTERTOP_PO]]),
  })
  assert.deepEqual(orders, [])
  assert.equal(unrouted.length, 2)
  assert.equal(unrouted[0].reason, "no_commitment")
  assert.equal(unrouted[0].cost_delta_cents, 120_000)
  assert.equal(unrouted[1].reason, "no_cost_code")
  assert.equal(unrouted[1].description, "Kitchen countertop — Level 4 granite")
})

test("re-planning the same executed change is stable, so idempotency only has to guard the write", () => {
  const input = {
    changes: [change({ selection_id: "sel-1" }), change({ selection_id: "sel-2", cost_code_id: "cc-trim", cost_delta_cents: 10_000 })],
    commitmentByCostCode: costCodeIndex([["cc-countertop", COUNTERTOP_PO], ["cc-trim", TRIM_PO]]),
  }
  assert.deepEqual(planSelectionVarianceOrders(input), planSelectionVarianceOrders(input))
})

test("the change description is what the vendor reads on the line", () => {
  assert.equal(describeSelectionChange({ category_name: "Flooring", option_name: "Engineered oak" }), "Flooring — Engineered oak")
})

// --- Fix 2: a post-cutoff fee needs a cutoff that actually passed -----------

test("an open group with a future cutoff is not post-cutoff", () => {
  assert.equal(
    isSelectionPastCutoff({ selectionLockedAt: null, group: { status: "open", cutoff_date: "2026-09-01" }, today: "2026-08-17" }),
    false,
  )
})

test("a locked group, a passed date, or a locked selection are each post-cutoff", () => {
  assert.equal(isSelectionPastCutoff({ selectionLockedAt: null, group: { status: "locked", cutoff_date: "2026-09-01" }, today: "2026-08-17" }), true)
  assert.equal(isSelectionPastCutoff({ selectionLockedAt: null, group: { status: "open", cutoff_date: "2026-08-16" }, today: "2026-08-17" }), true)
  assert.equal(isSelectionPastCutoff({ selectionLockedAt: "2026-08-01T00:00:00Z", group: null, today: "2026-08-17" }), true)
})

test("the cutoff day itself is still open — a fee starts the day after", () => {
  assert.equal(isSelectionPastCutoff({ selectionLockedAt: null, group: { status: "open", cutoff_date: "2026-08-17" }, today: "2026-08-17" }), false)
})

test("a selection with no group and no lock can never be charged a post-cutoff fee", () => {
  assert.equal(isSelectionPastCutoff({ selectionLockedAt: null, group: null, today: "2026-08-17" }), false)
  assert.equal(isSelectionPastCutoff({ selectionLockedAt: null, group: { status: "open", cutoff_date: null }, today: "2026-08-17" }), false)
})

// --- Fix 3: segregation of duties on VPO approval --------------------------

test("a superintendent cannot approve the variance order he raised", () => {
  assert.match(
    vpoApprovalBlockReason({ status: "draft", isVariance: true, requestedBy: "user-1", approverId: "user-1" }),
    /someone other than the person who requested it/,
  )
})

test("a second pair of eyes may approve the same variance order", () => {
  assert.equal(vpoApprovalBlockReason({ status: "sent", isVariance: true, requestedBy: "user-1", approverId: "user-2" }), null)
})

test("a rejected change order cannot be resurrected by approving it", () => {
  assert.match(
    vpoApprovalBlockReason({ status: "rejected", isVariance: true, requestedBy: "user-1", approverId: "user-2" }),
    /rejected and cannot be approved/,
  )
  assert.match(
    vpoApprovalBlockReason({ status: "rejected", isVariance: false, requestedBy: null, approverId: "user-2" }),
    /rejected and cannot be approved/,
  )
})

test("voided stays blocked", () => {
  assert.match(vpoApprovalBlockReason({ status: "voided", isVariance: false, requestedBy: null, approverId: "user-2" }), /Voided/)
})

test("subcontract change orders keep their existing approval path", () => {
  // No reason code means no variance discipline: residential and commercial
  // sub COs must not acquire a requester/approver split they never had.
  assert.equal(vpoApprovalBlockReason({ status: "draft", isVariance: false, requestedBy: "user-1", approverId: "user-1" }), null)
})

test("an office VPO with no recorded requester is still approvable", () => {
  assert.equal(vpoApprovalBlockReason({ status: "draft", isVariance: true, requestedBy: null, approverId: "user-1" }), null)
})

// --- Fix 6: package selection is planned before anything is written ---------

const PACKAGE_MEMBERS = [
  { option_id: "opt-counter", category_id: "cat-counter" },
  { option_id: "opt-floor", category_id: "cat-floor" },
]

test("a package resolves every member onto the selection in its own group", () => {
  const plan = planPackageSelection({
    members: PACKAGE_MEMBERS,
    selections: [
      { id: "sel-counter", category_id: "cat-counter", group_id: "grp-interior" },
      { id: "sel-floor", category_id: "cat-floor", group_id: "grp-interior" },
      { id: "sel-elsewhere", category_id: "cat-roof", group_id: "grp-exterior" },
    ],
  })
  assert.equal(plan.groupId, "grp-interior")
  assert.deepEqual(plan.members.map((member) => member.selectionId), ["sel-counter", "sel-floor"])
  assert.deepEqual(plan.members.map((member) => member.index), [0, 1])
})

test("a package straddling two selection groups is refused instead of half-applied", () => {
  assert.throws(
    () =>
      planPackageSelection({
        members: PACKAGE_MEMBERS,
        selections: [
          { id: "sel-counter", category_id: "cat-counter", group_id: "grp-interior" },
          { id: "sel-floor", category_id: "cat-floor", group_id: "grp-exterior" },
        ],
      }),
    /more than one selection group/,
  )
})

test("a package that cannot reach every member fails before the first write", () => {
  assert.throws(
    () =>
      planPackageSelection({
        members: PACKAGE_MEMBERS,
        selections: [{ id: "sel-counter", category_id: "cat-counter", group_id: "grp-interior" }],
      }),
    /does not match this lot's selection groups/,
  )
})

test("two package options pointing at the same selection is a catalog error", () => {
  assert.throws(
    () =>
      planPackageSelection({
        members: [
          { option_id: "opt-a", category_id: "cat-counter" },
          { option_id: "opt-b", category_id: "cat-counter" },
        ],
        selections: [{ id: "sel-counter", category_id: "cat-counter", group_id: "grp-interior" }],
      }),
    /more than one option to the same selection/,
  )
})

test("an empty or uncategorised package is rejected", () => {
  assert.throws(() => planPackageSelection({ members: [], selections: [] }), /no available options/)
  assert.throws(
    () => planPackageSelection({ members: [{ option_id: "opt-a", category_id: null }], selections: [] }),
    /no category/,
  )
})

// --- Fix 7: the structural lock follows contract status, not signed_at ------

test("an executed purchase agreement locks structural options", () => {
  assert.equal(agreementLocksStructuralOptions({ status: "active", signed_at: "2026-05-01T00:00:00Z" }), true)
  assert.equal(agreementLocksStructuralOptions({ status: "signed", signed_at: "2026-05-01T00:00:00Z" }), true)
})

test("a voided agreement releases the structural lock for the next buyer", () => {
  assert.equal(agreementLocksStructuralOptions({ status: "void", signed_at: "2026-05-01T00:00:00Z" }), false)
  assert.equal(agreementLocksStructuralOptions({ status: "superseded", signed_at: "2026-05-01T00:00:00Z" }), false)
})

test("an unsigned or missing agreement never locks", () => {
  assert.equal(agreementLocksStructuralOptions({ status: "draft", signed_at: null }), false)
  assert.equal(agreementLocksStructuralOptions(null), false)
  assert.equal(agreementLocksStructuralOptions(undefined), false)
})

// --- Fix 5: the scoped variance report matches the RPC ---------------------

function fact(overrides) {
  return {
    project_id: "proj-1",
    total_cents: 100_000,
    approved_at: "2026-03-14T12:00:00Z",
    reason_code_id: "reason-1",
    reason_label: "Selection after cutoff",
    community_id: "comm-1",
    community_name: "Willow Bend",
    house_plan_id: "plan-1",
    plan_name: "Aspen",
    division_id: "div-1",
    division_name: "North",
    company_id: "vendor-1",
    company_name: "Stoneworks",
    superintendent_id: "user-9",
    superintendent_name: "Dana Reyes",
    ...overrides,
  }
}

test("the scoped report carries all seven dimensions, not just reason and vendor", () => {
  const rows = aggregateVarianceFacts([fact({})], new Map([["proj-1", 10_000_000]]))
  assert.deepEqual(
    Array.from(new Set(rows.map((row) => row.dimension))).sort(),
    ["community", "division", "month", "plan", "reason", "superintendent", "vendor"],
  )
})

test("months are keyed off the approval date the way the RPC keys them", () => {
  const rows = aggregateVarianceFacts([fact({})], new Map())
  const month = rows.find((row) => row.dimension === "month")
  assert.equal(month.dimension_id, "2026-03")
  assert.equal(month.dimension_label, "Mar 2026")
})

test("net and absolute variance diverge when a credit offsets an overrun", () => {
  const rows = aggregateVarianceFacts(
    [fact({ total_cents: 100_000 }), fact({ total_cents: -40_000 })],
    new Map([["proj-1", 10_000_000]]),
  )
  const reason = rows.find((row) => row.dimension === "reason")
  assert.equal(reason.net_variance_cents, 60_000)
  assert.equal(reason.absolute_variance_cents, 140_000)
  assert.equal(reason.incidence, 2)
  assert.equal(reason.direct_cost_budget_cents, 10_000_000)
  assert.equal(reason.variance_rate, 140_000 / 10_000_000)
})

test("a dimension's budget denominator counts each contributing project once", () => {
  const rows = aggregateVarianceFacts(
    [
      fact({ project_id: "proj-1" }),
      fact({ project_id: "proj-1" }),
      fact({ project_id: "proj-2" }),
    ],
    new Map([["proj-1", 4_000_000], ["proj-2", 6_000_000]]),
  )
  assert.equal(rows.find((row) => row.dimension === "reason").direct_cost_budget_cents, 10_000_000)
})

test("missing dimension values fall back to the RPC's labels", () => {
  const rows = aggregateVarianceFacts(
    [fact({ community_id: null, community_name: null, house_plan_id: null, plan_name: null, division_id: null, division_name: null, company_id: null, company_name: null, superintendent_id: null, superintendent_name: null, reason_code_id: null, reason_label: null })],
    new Map(),
  )
  const labelFor = (dimension) => rows.find((row) => row.dimension === dimension).dimension_label
  assert.equal(labelFor("community"), "No community")
  assert.equal(labelFor("plan"), "No plan")
  assert.equal(labelFor("division"), "Main")
  assert.equal(labelFor("vendor"), "No vendor")
  assert.equal(labelFor("superintendent"), "Unassigned")
  assert.equal(labelFor("reason"), "Unclassified")
  assert.equal(rows.find((row) => row.dimension === "reason").dimension_id, "")
})

test("a project with no budget yields a zero variance rate rather than dividing by zero", () => {
  const rows = aggregateVarianceFacts([fact({})], new Map())
  assert.equal(rows.every((row) => row.variance_rate === 0), true)
})
