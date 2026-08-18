require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule } = require("./support/starts-harness")

const ORG = "00000000-0000-4000-8000-000000000001"
const ACTOR = "00000000-0000-4000-8000-000000000002"
const PROJECT = "00000000-0000-4000-8000-000000000004"
const LOT = "00000000-0000-4000-8000-000000000005"
const COMMUNITY = "00000000-0000-4000-8000-000000000006"
const VERSION_ONE = "00000000-0000-4000-8000-000000000011"
const VERSION_TWO = "00000000-0000-4000-8000-000000000012"
const PLAN = "00000000-0000-4000-8000-000000000013"

const SNAPSHOT = {
  budget_template: { id: "tpl-1", name: "Base", lines: [{ id: "line-1", cost_code_id: null, cost_type: "material", description: "Slab", amount_cents: 500_000, quantity: null, unit_cost_cents: null }] },
  schedule_template: { name: "Base", items: [{ name: "Excavate", start_offset_days: 0, duration_days: 3 }] },
  checklists: [],
  selection_categories: [],
  drawing_source_file_id: null,
  captured_at: "2026-08-01T00:00:00.000Z",
}

function version(id) {
  return {
    id, org_id: ORG, house_plan_id: PLAN, status: "released", version_number: id === VERSION_ONE ? 1 : 2,
    budget_template_id: "tpl-1", schedule_template_id: "sch-1", drawing_source_file_id: null,
    bundle_snapshot: SNAPSHOT,
  }
}

function buildInstantiationHarness({ projectMetadata = {}, onCreateBudget } = {}) {
  const supabase = createFakeSupabase({
    orgs: [{ id: ORG, product_tier: "production" }],
    org_settings: [{ org_id: ORG, settings: {} }],
    projects: [{ id: PROJECT, org_id: ORG, metadata: projectMetadata }],
    lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, project_id: PROJECT, house_plan_version_id: null, swing: "left" }],
    house_plan_versions: [version(VERSION_ONE), version(VERSION_TWO)],
    project_financial_settings: [],
    house_plan_takeoff_lines: [],
    community_plan_availability: [{ id: "cpa-1", org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, is_available: true, elevation_id: null, effective_start: null, effective_end: null }],
    cost_codes: [],
    house_plan_elevations: [],
  })
  const context = { supabase, orgId: ORG, userId: ACTOR, productTier: "production" }
  const calls = { budgets: [], schedules: [], inspections: [], selectionGroups: [] }

  stubModule("@/lib/services/context", {
    requireOrgContext: async () => context,
    runWithServiceOrgContext: async (_context, work) => work(),
  })
  stubModule("@/lib/services/permissions", { requirePermission: async () => undefined })
  stubModule("@/lib/services/audit", { recordAudit: async () => undefined })
  stubModule("@/lib/services/events", { recordEvent: async () => ({ id: "event-1" }) })
  stubModule("@/lib/services/orgs", { getOrgSettings: async () => ({}) })
  stubModule("@/lib/services/budget-templates", { getBudgetTemplate: async () => SNAPSHOT.budget_template })
  stubModule("@/lib/services/budgets", {
    createBudget: async (input) => {
      calls.budgets.push(input)
      if (onCreateBudget) await onCreateBudget()
      return { id: `budget-${calls.budgets.length}` }
    },
  })
  stubModule("@/lib/services/schedule", {
    applyScheduleTemplateSnapshot: async (...args) => { calls.schedules.push(args); return [{ id: "item-1" }] },
  })
  stubModule("@/lib/services/inspections", {
    createInspectionFromSnapshot: async () => { calls.inspections.push(1); return { id: "inspection-1" } },
  })
  stubModule("@/lib/services/selection-cutoffs", {
    instantiateSelectionGroupsForProject: async () => { calls.selectionGroups.push(1); return { groups: 1, selections: 1 } },
  })
  stubModule("@/lib/storage/files-storage", {
    buildOrgScopedPath: () => "path", createFilesDownloadUrl: async () => ({ downloadUrl: "" }), uploadFilesObject: async () => undefined,
  })
  delete require.cache[require.resolve("@/lib/services/plan-instantiation")]
  return { supabase, calls, service: require("@/lib/services/plan-instantiation") }
}

function input(versionId, steps) {
  return {
    projectId: PROJECT, lotId: LOT, housePlanVersionId: versionId, elevationId: null,
    communityId: COMMUNITY, startDate: "2026-09-07", steps,
  }
}

function ledger(supabase) {
  return supabase.store.projects[0].metadata.plan_instantiation ?? {}
}

test("instantiation records what it produced, and a repeat is refused by default", async () => {
  const harness = buildInstantiationHarness()
  const first = await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))
  assert.equal(first.success, true)
  assert.equal(harness.calls.budgets.length, 1)
  assert.ok(ledger(harness.supabase).produced.budget, "the artifact is recorded outside the per-version map")

  const repeat = await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))
  assert.equal(repeat.success, false)
  assert.deepEqual(repeat.skipped, ["budget"])
  assert.equal(harness.calls.budgets.length, 1, "no second budget")
})

test("a different plan version cannot quietly generate a second budget", async () => {
  const harness = buildInstantiationHarness()
  await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))
  assert.equal(harness.calls.budgets.length, 1)

  // The old ledger reset `completed` whenever `version_id` changed, so this cut
  // a second budget onto the same house without a word.
  const nextVersion = await harness.service.instantiatePlanForProject(input(VERSION_TWO, ["budget"]))
  assert.equal(nextVersion.success, false)
  assert.match(nextVersion.errors[0], /different plan version/)
  assert.equal(harness.calls.budgets.length, 1, "still one budget")
})

test("a resuming worker treats an already-produced step as done, not as fatal", async () => {
  const harness = buildInstantiationHarness()
  await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))

  const resumed = await harness.service.instantiatePlanForProject({ ...input(VERSION_ONE, ["budget"]), resume: true })
  assert.equal(resumed.success, true, "a resume must not park the release in attention forever")
  assert.deepEqual(resumed.skipped, ["budget"])
  assert.match(resumed.warnings.join(" "), /already instantiated/)
  assert.equal(harness.calls.budgets.length, 1)
})

test("concurrent marks against one project do not lose each other", async () => {
  // The outbox retry path is exactly this shape: the old read-modify-write
  // dropped whichever mark landed second, and a dropped mark is how a release
  // comes to believe a step it already ran is still pending.
  const harness = buildInstantiationHarness()
  const [budgetResult, checklists] = await Promise.all([
    harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"])),
    harness.service.instantiatePlanForProject(input(VERSION_ONE, ["checklists"])),
  ])

  assert.equal(checklists.success, true)
  assert.equal(budgetResult.success, true)
  const produced = ledger(harness.supabase).produced
  assert.ok(produced.budget, "the budget mark survived the concurrent write")
  assert.ok(produced.checklists, "the checklist mark survived the concurrent write")
  assert.equal(ledger(harness.supabase).seq, 2, "each mark advanced the ledger exactly once")
})

test("a legacy ledger with no seq is upgraded rather than double-run", async () => {
  const harness = buildInstantiationHarness({
    projectMetadata: { plan_instantiation: { version_id: VERSION_ONE, steps: { budget: { at: "2026-08-01T00:00:00.000Z" } }, at: "2026-08-01T00:00:00.000Z" } },
  })
  const result = await harness.service.instantiatePlanForProject({ ...input(VERSION_ONE, ["budget", "checklists"]), resume: true })
  assert.equal(result.success, true)
  assert.deepEqual(result.skipped, ["budget"], "the pre-`produced` mark is still honoured")
  assert.equal(harness.calls.budgets.length, 0)
  assert.equal(harness.calls.inspections.length, 0, "the snapshot has no checklists to seed")
  assert.equal(ledger(harness.supabase).seq, 1)
})
