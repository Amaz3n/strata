"use strict"

require("../../scripts/register-ts-node-test")

const { createFakeSupabase } = require("./fake-supabase")

const ORG = "00000000-0000-4000-8000-000000000001"
const ACTOR = "00000000-0000-4000-8000-000000000002"
const PACKAGE = "00000000-0000-4000-8000-000000000003"
const PROJECT = "00000000-0000-4000-8000-000000000004"
const LOT = "00000000-0000-4000-8000-000000000005"
const COMMUNITY = "00000000-0000-4000-8000-000000000006"
const VERSION = "00000000-0000-4000-8000-000000000007"
const ELEVATION = "00000000-0000-4000-8000-000000000008"
const ROLE = "00000000-0000-4000-8000-000000000009"

const RELEASE_STEPS = ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"]

function stubModule(request, exports) {
  const filename = require.resolve(request)
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] }
  return exports
}

/**
 * Everything the start services touch that is not the thing under test. The
 * fake Supabase client and the plan-instantiation / PO-generation seams are
 * where the interesting behaviour lives, so those get real recorders; audit,
 * events and notifications are noise here.
 */
function installStubs({ supabase, context, instantiate, generatePurchaseOrders, transferLandAtStart, slotTarget = 4 }) {
  const calls = { instantiate: [], purchaseOrders: [], events: [], notifications: [], projects: [], outbox: [], landTransfers: [] }

  stubModule("@/lib/services/context", {
    requireOrgContext: async () => context,
    runWithServiceOrgContext: async (_context, work) => work(),
    getOrgProductTier: async () => context.productTier,
  })
  stubModule("@/lib/services/permissions", {
    requirePermission: async () => undefined,
    getCurrentUserPermissions: async () => ({ permissions: ["*"] }),
  })
  stubModule("@/lib/services/audit", { recordAudit: async () => undefined })
  stubModule("@/lib/services/events", {
    recordEvent: async (event) => { calls.events.push(event); return { id: `event-${calls.events.length}` } },
  })
  stubModule("@/lib/services/notifications", {
    NotificationService: class {
      async createAndQueue(input) { calls.notifications.push(input) }
    },
  })
  stubModule("@/lib/services/outbox", {
    enqueueOutboxJob: async (input) => {
      calls.outbox.push(input)
      const rows = supabase.store.outbox ?? (supabase.store.outbox = [])
      rows.push({
        id: `job-${rows.length + 1}`, org_id: input.orgId, job_type: input.jobType, status: "pending",
        payload: input.payload, retry_count: 0, run_at: input.runAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        dedupe_key: `${input.jobType}:start_package_id:${input.payload.start_package_id}`,
      })
      return { enqueued: true }
    },
  })
  stubModule("@/lib/services/authorization", {
    getDivisionAccessForUser: async () => ({ assignedOnly: false, divisionIds: [] }),
    getDivisionScopedProjectIds: async () => null,
  })
  stubModule("@/lib/services/projects", {
    createProject: async ({ input }) => { calls.projects.push(input); return { id: PROJECT } },
  })
  stubModule("@/lib/services/books/inventory", {
    transferLandAtStartForService: async (orgId, lotId, date, actorId) => {
      const input = { orgId, lotId, date, actorId }
      calls.landTransfers.push(input)
      return transferLandAtStart ? transferLandAtStart(input) : undefined
    },
  })
  stubModule("@/lib/services/starts-pipeline-trigger", { triggerStartsPipeline: async () => undefined })
  stubModule("@/lib/services/even-flow", {
    getReleaseSlotTarget: async () => slotTarget,
    ensureReleaseSlotsForActiveCommunities: async () => undefined,
    getMissedStarts: async () => ({ weeks: 4, missed: 0, from: "2026-08-10", to: "2026-08-31" }),
    getCommunityReleaseSlots: async () => [],
  })
  stubModule("@/lib/services/trade-lookahead", {
    sendTradeLookahead: async () => ({ sent: true }),
    sendScheduleChangeDigestJob: async () => undefined,
  })
  stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => supabase })
  stubModule("@/lib/services/plan-instantiation", {
    instantiatePlanForProject: async (input) => {
      calls.instantiate.push(input)
      return instantiate(input)
    },
  })
  stubModule("@/lib/services/po-generation", {
    generatePurchaseOrders: async (input) => {
      calls.purchaseOrders.push(input)
      return generatePurchaseOrders ? generatePurchaseOrders(input) : { runId: "run-1", purchaseOrders: [], exceptions: [] }
    },
  })
  return calls
}

/** A released-ready package mid-orchestration, exactly as `releaseStart` leaves it. */
function releasingFixture({ purchasing = false, packageStatus = "releasing", metadata = {} } = {}) {
  const past = new Date(Date.now() - 60_000).toISOString()
  return {
    orgs: [{ id: ORG, product_tier: "production", name: "Fixture Homes", slug: "fixture" }],
    memberships: [{ id: "m-1", org_id: ORG, user_id: ACTOR, role_id: ROLE, status: "active" }],
    role_permissions: [{ role_id: ROLE, permission_key: "start.release" }],
    app_users: [{ id: ACTOR, full_name: "Casey Coordinator", email: "casey@example.com" }],
    communities: [{ id: COMMUNITY, org_id: ORG, name: "Cypress Run", status: "active", archived_at: null, settings: {} }],
    lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, status: "assigned", project_id: PROJECT, lot_number: "12" }],
    projects: [{ id: PROJECT, org_id: ORG, status: "active", phase: "precon", property_type: "production", metadata: {}, superintendent_id: null, start_date: null }],
    house_plan_versions: [{ id: VERSION, org_id: ORG, status: "released" }],
    vendor_price_agreements: purchasing
      ? [{ id: "vpa-1", org_id: ORG, status: "active", community_id: COMMUNITY }]
      : [],
    start_packages: [{
      id: PACKAGE, org_id: ORG, lot_id: LOT, community_id: COMMUNITY, project_id: PROJECT,
      status: packageStatus, is_financed: false, target_week: "2026-09-07",
      scheduled_start_date: "2026-09-07", released_at: null, actual_start_date: null,
      notes: null, metadata, created_at: past,
      lot: { house_plan_version_id: VERSION, house_plan_elevation_id: ELEVATION, swing: "left", status: "assigned" },
    }],
    start_release_steps: RELEASE_STEPS.map((stepKey, index) => ({
      id: `step-${index}`, org_id: ORG, start_package_id: PACKAGE, step_key: stepKey,
      status: stepKey === "project" ? "completed" : "pending", attempt: 0,
      started_at: null, completed_at: null, error: null, detail: {}, created_at: `2026-09-01T00:0${index}:00.000Z`,
    })),
    start_gate_definitions: [],
    start_package_gates: [],
    schedule_assignments: [],
    outbox: [{
      id: "job-1", org_id: ORG, job_type: "start_release", status: "pending",
      payload: { start_package_id: PACKAGE, actor_id: ACTOR }, retry_count: 0,
      run_at: past, updated_at: past, dedupe_key: `start_release:start_package_id:${PACKAGE}`,
    }],
  }
}

function claimJobs({ job_types: jobTypes, limit_value: limit }, store) {
  const now = new Date().toISOString()
  const claimed = (store.outbox ?? [])
    .filter((row) => jobTypes.includes(row.job_type) && row.status === "pending" && (!row.run_at || row.run_at <= now))
    .slice(0, limit)
  for (const row of claimed) row.status = "processing"
  return {
    data: claimed.map((row) => ({
      job_id: row.id, org_id: row.org_id, job_type: row.job_type,
      payload: JSON.parse(JSON.stringify(row.payload)), retry_count: row.retry_count,
    })),
    error: null,
  }
}

function buildHarness(options = {}) {
  const supabase = createFakeSupabase(options.tables ?? releasingFixture(options), { claim_jobs: claimJobs })
  const context = { supabase, orgId: ORG, userId: ACTOR, productTier: "production" }
  const calls = installStubs({ supabase, context, ...options })
  return { supabase, context, calls, store: supabase.store }
}

/** The default instantiation seam: every step succeeds and reports an artifact. */
function succeedingInstantiation() {
  return async (input) => {
    const step = input.steps[0]
    const outputs = {
      budget: { budget_id: "budget-1", total_cents: 100_000, line_count: 4, pricing: [] },
      schedule: { item_ids: ["item-1"], start_date: input.startDate, end_date: input.startDate },
      checklists: { inspection_ids: ["inspection-1"] },
      drawings: { drawing_set_id: "set-1", queued: true },
    }
    return { success: true, skipped: [], warnings: [], errors: [], [step]: outputs[step] }
  }
}

function stepsByKey(store) {
  return new Map(store.start_release_steps.map((step) => [step.step_key, step]))
}

module.exports = {
  ACTOR, COMMUNITY, ELEVATION, LOT, ORG, PACKAGE, PROJECT, RELEASE_STEPS, ROLE, VERSION,
  buildHarness, claimJobs, installStubs, releasingFixture, stepsByKey, stubModule, succeedingInstantiation,
}
