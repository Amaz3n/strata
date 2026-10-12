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
const ELEVATION = "00000000-0000-4000-8000-000000000014"

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

function buildInstantiationHarness({ projectMetadata = {}, onCreateBudget, deleteFails = false } = {}) {
  const supabase = createFakeSupabase({
    orgs: [{ id: ORG, product_tier: "production" }],
    org_settings: [{ org_id: ORG, settings: {} }],
    projects: [{ id: PROJECT, org_id: ORG, metadata: projectMetadata }],
    lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, project_id: PROJECT, house_plan_version_id: null, swing: "left", metadata: {}, updated_at: "2026-09-01T00:00:00+00:00" }],
    house_plan_versions: [version(VERSION_ONE), version(VERSION_TWO)],
    project_financial_settings: [],
    house_plan_takeoff_lines: [],
    community_plan_availability: [{ id: "cpa-1", org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, is_available: true, elevation_id: null, effective_start: null, effective_end: null }],
    cost_codes: [],
    house_plan_elevations: [{ id: ELEVATION, org_id: ORG, house_plan_id: PLAN, is_active: true }],
  })
  const context = { supabase, orgId: ORG, userId: ACTOR, productTier: "production" }
  const calls = { budgets: [], schedules: [], inspections: [], selectionGroups: [], copies: [], deletes: [], cleared: [] }

  stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => supabase })
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
    buildOrgScopedPath: (...parts) => parts.join("/"), copyFilesObject: async (params) => { calls.copies.push(params); return { size: 100, sourceEtag: "source-etag", etag: "copy-etag" } },
    deleteFilesObjects: async (params) => {
      calls.deletes.push(params.paths)
      if (deleteFails) throw new Error("Storage unavailable")
    },
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

test("a superseded version is built only where a plan change review kept the home on it", async () => {
  const harness = buildInstantiationHarness()
  harness.supabase.store.house_plan_versions[0].status = "superseded"
  harness.supabase.store.plan_change_proposal_homes = []
  await assert.rejects(harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"])), /Only released plan versions/)

  harness.supabase.store.plan_change_proposal_homes.push({ id: "review-home-1", org_id: ORG, lot_id: LOT, from_version_id: VERSION_ONE, decision: "decline" })
  await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))
  assert.equal(harness.calls.budgets.length, 1)
})

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

test("a resuming worker refuses a step another plan version produced instead of counting it done", async () => {
  const harness = buildInstantiationHarness()
  await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))

  const resumed = await harness.service.instantiatePlanForProject({ ...input(VERSION_TWO, ["budget"]), resume: true })
  assert.equal(resumed.success, false)
  assert.match(resumed.errors.join(" "), /different plan version/)
  assert.equal(harness.calls.budgets.length, 1, "and it does not cut a second budget either")
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

function drawingContext(harness) {
  harness.supabase.store.files = [{ id: 'plan-pdf', org_id: ORG, file_name: 'plan.pdf', storage_path: 'source.pdf', mime_type: 'application/pdf', size_bytes: 100, checksum: 'hash' }]
  return { supabase: harness.supabase, orgId: ORG, userId: ACTOR, project: harness.supabase.store.projects[0], version: version(VERSION_ONE), snapshot: { ...SNAPSHOT, drawing_source_file_id: 'plan-pdf' } }
}
test('pending drawing review is checked before copying or inserting the plan PDF', async () => {
  const harness = buildInstantiationHarness(), context = drawingContext(harness)
  harness.supabase.store.drawing_revisions = [{ id: 'pending', org_id: ORG, project_id: PROJECT, status: 'processing' }]
  await assert.rejects(harness.service.queuePlanDrawings(input(VERSION_ONE, ['drawings']), context), /already pending review/)
  assert.equal(harness.calls.copies.length, 0)
  assert.equal(harness.supabase.store.files.length, 1)
})
test('uncertain pending drawing state fails before storage writes', async () => {
  const harness = buildInstantiationHarness(), context = drawingContext(harness), from = harness.supabase.from.bind(harness.supabase)
  harness.supabase.from = table => {
    const query = from(table)
    if (table === 'drawing_revisions') query.then = resolve => Promise.resolve({ data: null, error: { message: 'database unavailable' } }).then(resolve)
    return query
  }
  await assert.rejects(harness.service.queuePlanDrawings(input(VERSION_ONE, ['drawings']), context), /Failed to check pending drawing revisions/)
  assert.equal(harness.calls.copies.length, 0)
  assert.equal(harness.supabase.store.files.length, 1)
})
test('drawing copies persist storage version evidence and use a fresh destination on each attempt', async () => {
  const harness = buildInstantiationHarness(), context = drawingContext(harness)
  await harness.service.queuePlanDrawings(input(VERSION_ONE, ['drawings']), context)
  const first = harness.supabase.store.files.find(file => file.project_id === PROJECT)
  assert.equal(first.size_bytes, 100)
  assert.equal(first.metadata.source_storage_etag, 'source-etag')
  assert.equal(first.metadata.storage_etag, 'copy-etag')
  assert.equal(harness.calls.copies[0].sourcePath, 'source.pdf')
  assert.equal(harness.calls.copies[0].expectedSize, 100)
  harness.supabase.store.drawing_revisions[0].status = 'published'
  await harness.service.queuePlanDrawings(input(VERSION_ONE, ['drawings']), context)
  assert.notEqual(harness.calls.copies[0].destinationPath, harness.calls.copies[1].destinationPath)
  assert.match(harness.calls.copies[0].destinationPath, new RegExp(`${PROJECT}/plans/${VERSION_ONE}/[a-f0-9-]+/plan.pdf$`))
})
test('disabling transactions with a durable attempt refuses a duplicate legacy copy', async () => {
  const harness = buildInstantiationHarness({ projectMetadata: { plan_instantiation: { drawing_copy_attempt: { status: 'reserved' } } } }), context = drawingContext(harness)
  await assert.rejects(harness.service.queuePlanDrawings(input(VERSION_ONE, ['drawings']), context), /Recover the reserved drawing copy/)
  assert.equal(harness.calls.copies.length, 0)
})

function abandonedCopy(harness) {
  const copy = { org_id: ORG, project_id: PROJECT, attempt_id: "00000000-0000-4000-8000-0000000000aa", storage_path: `${ORG}/projects/${PROJECT}/plans/copy.pdf` }
  harness.supabase.rpc = async (name, args) => {
    if (name === "claim_abandoned_plan_drawing_copies") return { data: [copy], error: null }
    if (name === "clear_abandoned_plan_drawing_copy") { harness.calls.cleared.push(args); return { data: true, error: null } }
    throw new Error(`unexpected rpc ${name}`)
  }
  return copy
}
test('an abandoned copy loses its object before its manifest, and a failed delete keeps the manifest', async () => {
  const harness = buildInstantiationHarness(), copy = abandonedCopy(harness)
  assert.deepEqual(await harness.service.cleanupAbandonedPlanDrawingCopies(), { claimed: 1, cleared: 1 })
  assert.deepEqual(harness.calls.deletes, [[copy.storage_path]])
  assert.equal(harness.calls.cleared[0].p_attempt_id, copy.attempt_id)

  const failing = buildInstantiationHarness({ deleteFails: true })
  abandonedCopy(failing)
  await assert.rejects(failing.service.cleanupAbandonedPlanDrawingCopies(), /Storage unavailable/)
  assert.equal(failing.calls.cleared.length, 0)
})

test("a plan the lot's community does not offer is refused, not warned about", async () => {
  const harness = buildInstantiationHarness()
  harness.supabase.store.community_plan_availability[0].is_available = false

  await assert.rejects(harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"])), /not offered in the lot's community/)
  assert.equal(harness.calls.budgets.length, 0)
  assert.equal(harness.supabase.store.lots[0].house_plan_version_id, null, "the lot is not pinned to the plan")
})

test("an elevation the plan sheet does not carry is refused, and an inactive one cannot be built", async () => {
  const harness = buildInstantiationHarness()
  harness.supabase.store.community_plan_availability[0].elevation_id = "00000000-0000-4000-8000-0000000000ff"
  await assert.rejects(harness.service.instantiatePlanForProject({ ...input(VERSION_ONE, ["budget"]), elevationId: ELEVATION }), /not offered/)

  const inactive = buildInstantiationHarness()
  inactive.supabase.store.house_plan_elevations[0].is_active = false
  await assert.rejects(inactive.service.instantiatePlanForProject({ ...input(VERSION_ONE, ["budget"]), elevationId: ELEVATION }), /inactive/)
})

test("a recorded offering override lets the plan through, with the reason carried as a warning", async () => {
  const harness = buildInstantiationHarness()
  harness.supabase.store.community_plan_availability[0].is_available = false
  await harness.service.recordPlanOfferingOverride({ lotId: LOT, housePlanId: PLAN, reason: "Buyer signed before the plan was withdrawn" })

  const result = await harness.service.instantiatePlanForProject(input(VERSION_ONE, ["budget"]))
  assert.equal(result.success, true)
  assert.match(result.warnings.join(" "), /Buyer signed before the plan was withdrawn/)
})

test("an offering override needs a real reason", async () => {
  const harness = buildInstantiationHarness()
  await assert.rejects(harness.service.recordPlanOfferingOverride({ lotId: LOT, housePlanId: PLAN, reason: "ok" }), /Say why/)
  assert.deepEqual(harness.supabase.store.lots[0].metadata, {})
})
