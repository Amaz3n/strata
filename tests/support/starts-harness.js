"use strict"

require("../../scripts/register-ts-node-test")

const { randomUUID } = require("node:crypto")

const { createFakeSupabase } = require("./fake-supabase")
const { SQL_EVIDENCE_SOURCES, canAttestFinalApproval, isGateApplicable, startPackageReadiness } = require("@/lib/starts/gate-logic")

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
  const calls = { instantiate: [], purchaseOrders: [], events: [], notifications: [], projects: [], outbox: [], landTransfers: [], tradeNotices: [] }

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
    recordEvent: async (event) => {
      const prior = event.idempotencyId && calls.events.find(row => row.idempotencyId === event.idempotencyId)
      if (!prior) calls.events.push(event)
      return { id: event.idempotencyId ?? `event-${calls.events.length}` }
    },
  })
  stubModule("@/lib/services/notifications", {
    NotificationService: class {
      async createAndQueue(input, options) {
        const prior = options?.idempotencyId && calls.notifications.find(row => row.idempotencyId === options.idempotencyId)
        if (!prior) calls.notifications.push({ ...input, ...(options ? { idempotencyId: options.idempotencyId } : {}) })
      }
    },
  })
  stubModule("@/lib/services/outbox", {
    enqueueOutboxJob: async (input) => {
      calls.outbox.push(input)
      const rows = supabase.store.outbox ?? (supabase.store.outbox = [])
      const dedupeKey = `${input.jobType}:${(input.dedupeByPayloadKeys ?? ["start_package_id"]).map((key) => `${key}:${input.payload[key]}`).join("|")}`
      if (rows.some((row) => row.org_id === input.orgId && row.dedupe_key === dedupeKey && row.status === "pending")) return { enqueued: false, reason: "duplicate" }
      rows.push({
        id: rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1, org_id: input.orgId, job_type: input.jobType, status: "pending",
        payload: input.payload, retry_count: 0, run_at: input.runAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        dedupe_key: dedupeKey,
      })
      return { enqueued: true }
    },
  })
  stubModule("@/lib/services/authorization", {
    authorize: async () => ({ allowed: true }),
    getDivisionAccessForUser: async () => ({ assignedOnly: false, divisionIds: [] }),
    getDivisionScopedProjectIds: async () => null,
  })
  // The pure helpers that prepare a new home; SQL writes what they return.
  stubModule("@/lib/services/projects", {
    prepareProjectCreation: ({ input, orgId, userId }) => {
      calls.projects.push(input)
      return { input, project: { ...input, org_id: orgId, created_by: userId } }
    },
    // A production home opens no placeholder contract; its purchase agreement is its revenue contract.
    prepareProjectOpeningContract: () => null,
    prepareProjectAccountingDimensions: () => ({}),
  })
  stubModule("@/lib/services/project-financial-setup", {
    prepareProjectFinancialSettings: ({ orgId, projectId, userId }) => ({ org_id: orgId, project_id: projectId, created_by: userId }),
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
    sendTradeLookahead: async (...args) => { calls.tradeNotices.push(args); return { sent: true } },
    sendScheduleChangeDigestJob: async () => undefined,
  })
  stubModule("@/lib/supabase/server", {
    createServiceSupabaseClient: () => supabase,
    createStartsWorkerSupabaseClient: () => supabase,
  })
  stubModule("@/lib/services/plan-instantiation", {
    instantiatePlanForProject: async (input) => {
      calls.instantiate.push(input)
      return instantiate(input)
    },
    cleanupAbandonedPlanDrawingCopies: async () => ({ claimed: 0, cleared: 0 }),
  })
  stubModule("@/lib/services/po-generation", {
    generatePurchaseOrdersForStartsRelease: async (input) => {
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
      started_at: null, completed_at: stepKey === "project" ? past : null, error: null, detail: {}, created_at: `2026-09-01T00:0${index}:00.000Z`,
    })),
    start_gate_definitions: [{ id: "def-approval", org_id: ORG, key: "final_approval", label: "Final approval", check_kind: "manual", applies_when: "always", is_active: true }],
    start_package_gates: [{ id: "gate-approval", org_id: ORG, start_package_id: PACKAGE, gate_definition_id: "def-approval", status: "passed", passed_via: "attested", attested_by: ACTOR, attested_at: past }],
    schedule_assignments: [],
    outbox: [{
      id: 1, org_id: ORG, job_type: "start_release", status: "pending",
      payload: { start_package_id: PACKAGE, actor_id: ACTOR }, retry_count: 0,
      run_at: past, updated_at: past, dedupe_key: `start_release:start_package_id:${PACKAGE}`,
    }],
  }
}

// ---------------------------------------------------------------------------
// The starts claim protocol, as the staged SQL defines it
// (20261003048000_starts_release_and_purchasing_fences,
// 20261010100000_starts_release_control). The real functions are proven
// against the full schema in tests/starts-core-write-fences-db.test.js; these
// stand-ins only carry the state transitions the orchestrator relies on.
// ---------------------------------------------------------------------------

const STARTS_JOB_TYPES = ["start_release", "trade_schedule_change_notice", "start_release_trade_notice", "start_package_notice"]
const CLAIM_MS = 3 * 60_000
const PACKAGE_LEASE_MS = 5 * 60_000
const iso = (ms = Date.now()) => new Date(ms).toISOString()
const ok = (data) => ({ data, error: null })
const refused = (message) => ({ data: null, error: { message } })

function liveClaim(store, orgId, jobId, token) {
  return (store.outbox ?? []).find((row) => row.org_id === orgId && Number(row.id) === Number(jobId)
    && STARTS_JOB_TYPES.includes(row.job_type) && row.status === "processing"
    && row.start_claim_token === token && row.start_job_lease_expires_at > iso()) ?? null
}

function claimPackage(store, job) {
  return job.job_type === "start_release"
    ? store.start_packages.find((row) => row.org_id === job.org_id && row.id === job.payload.start_package_id) ?? null
    : null
}

function leaseFresh(pkg) {
  const at = Date.parse(pkg?.metadata?.release_lease_at ?? "")
  return Number.isFinite(at) && Date.now() - at < PACKAGE_LEASE_MS
}

function clearLease(pkg) {
  pkg.metadata = { ...(pkg.metadata ?? {}), release_lease_token: null, release_lease_at: null }
}

function enqueue(store, row) {
  const id = (store.outbox ??= []).reduce((max, job) => Math.max(max, Number(job.id)), 0) + 1
  store.outbox.push({ id, status: "pending", retry_count: 0, run_at: iso(), updated_at: iso(), ...row })
  return id
}

/** What the SQL writes beside every package change: its audit and its event. */
function record(store, { orgId, actorId, entityType, entityId, source, eventType, payload, before = {}, after = {} }) {
  ;(store.audit_log ??= []).push({ org_id: orgId, actor_user_id: actorId, action: "update", entity_type: entityType, entity_id: entityId, before_data: before, after_data: after, source })
  const id = randomUUID()
  ;(store.events ??= []).push({ id, org_id: orgId, event_type: eventType, entity_type: entityType, entity_id: entityId, payload: { ...payload, actor_id: actorId } })
  return id
}

function queueNotice(store, pkg, kind, eventId, message = null) {
  enqueue(store, { org_id: pkg.org_id, job_type: "start_package_notice", payload: { start_package_id: pkg.id, kind, event_id: eventId, message } })
}

/** `record_start_release_failure`: the park's audit, event and notice, written with it. */
function recordReleaseFailure(store, job, pkg, error) {
  const eventId = record(store, {
    orgId: pkg.org_id, actorId: job.payload.actor_id ?? null, entityType: "start_package", entityId: pkg.id, source: "starts.release_failed",
    eventType: "start.release_failed", payload: { error, job_id: String(job.id) }, before: { status: "releasing" }, after: { status: "attention" },
  })
  queueNotice(store, pkg, "release_failed", eventId, error)
}

function releaseJobs(store, orgId, packageId) {
  return (store.outbox ?? []).filter((row) => row.org_id === orgId && row.job_type === "start_release"
    && row.payload?.start_package_id === packageId)
}

const claimProtocol = {
  claim_starts_jobs({ p_limit: limit }, store) {
    const claimed = (store.outbox ?? [])
      .filter((row) => STARTS_JOB_TYPES.includes(row.job_type) && row.status === "pending" && (!row.run_at || row.run_at <= iso()))
      .slice(0, limit)
    for (const row of claimed) {
      Object.assign(row, { status: "processing", updated_at: iso(), start_claim_token: randomUUID(), start_job_lease_expires_at: iso(Date.now() + CLAIM_MS) })
    }
    return ok(claimed.map((row) => ({
      job_id: Number(row.id), org_id: row.org_id, job_type: row.job_type,
      payload: JSON.parse(JSON.stringify(row.payload)), retry_count: row.retry_count, claim_token: row.start_claim_token,
    })))
  },

  transition_starts_job_lease({ p_org_id: orgId, p_id: jobId, p_token: token, p_action: action, p_error: failure }, store) {
    const job = liveClaim(store, orgId, jobId, token)
    if (!job) return ok(false)
    const pkg = claimPackage(store, job)
    if (action === "heartbeat" && pkg && pkg.status !== "releasing") return refused("Start package no longer releasing")
    if (action === "complete" && job.job_type === "start_release" && pkg?.status !== "released") {
      return refused("Starts completion requires a durably released package")
    }
    const held = pkg?.metadata?.release_lease_token ?? null
    if (action === "retry" && pkg && job.retry_count + 1 >= 3 && pkg.status === "releasing" && (held === null || held === token)) {
      pkg.status = "attention"
      recordReleaseFailure(store, job, pkg, failure)
    }
    if (action !== "heartbeat" && pkg && held === token) clearLease(pkg)
    const released = { updated_at: iso(), start_claim_token: null, start_job_lease_expires_at: null }
    if (action === "heartbeat") Object.assign(job, { updated_at: iso(), start_job_lease_expires_at: iso(Date.now() + CLAIM_MS) })
    else if (action === "defer") Object.assign(job, released, { status: "pending", run_at: iso(Date.now() + 60_000) })
    else if (action === "complete") Object.assign(job, released, { status: "completed", last_error: null })
    else {
      const retryCount = job.retry_count + 1
      Object.assign(job, released, {
        status: retryCount >= 3 ? "failed" : "pending", retry_count: retryCount, last_error: failure,
        run_at: retryCount >= 3 ? job.run_at : iso(Date.now() + 2 ** retryCount * 60_000),
      })
    }
    return ok(true)
  },

  transition_starts_package_lease({ p_org_id: orgId, p_job_id: jobId, p_token: token, p_action: action }, store) {
    const job = liveClaim(store, orgId, jobId, token)
    const pkg = job && claimPackage(store, job)
    if (!pkg) return ok(false)
    const held = pkg.metadata?.release_lease_token ?? null
    if (action === "clear") {
      if (held !== token) return ok(false)
      clearLease(pkg)
      return ok(true)
    }
    if (pkg.status !== "releasing") return ok(false)
    if (action === "heartbeat" && (held !== token || !leaseFresh(pkg))) return ok(false)
    if (action === "acquire" && held !== null && held !== token && leaseFresh(pkg)) return ok(false)
    pkg.metadata = { ...(pkg.metadata ?? {}), release_lease_token: token, release_lease_at: iso() }
    return ok(true)
  },

  recover_starts_job_leases(_args, store) {
    let recovered = 0
    for (const job of store.outbox ?? []) {
      if (job.status !== "processing" || !job.start_claim_token || job.start_job_lease_expires_at > iso()) continue
      const pkg = claimPackage(store, job)
      const held = pkg?.metadata?.release_lease_token ?? null
      if (pkg && (held === job.start_claim_token || held === null) && job.retry_count + 1 >= 3 && pkg.status === "releasing") {
        pkg.status = "attention"
        recordReleaseFailure(store, job, pkg, "Starts worker lease expired")
      }
      if (pkg && held === job.start_claim_token) clearLease(pkg)
      Object.assign(job, {
        status: job.retry_count + 1 >= 3 ? "failed" : "pending", retry_count: job.retry_count + 1,
        last_error: "Starts worker lease expired", run_at: iso(), start_claim_token: null, start_job_lease_expires_at: null,
      })
      recovered += 1
    }
    return ok(recovered)
  },

  publish_start_release({ p_org_id: orgId, p_job_id: jobId, p_token: token, p_event_id: eventId }, store) {
    const job = liveClaim(store, orgId, jobId, token)
    if (!job) return refused("Starts worker lease lost")
    const pkg = claimPackage(store, job)
    if (pkg?.status !== "releasing") return refused("Start package no longer releasing")
    if (pkg.metadata?.release_lease_token !== token || !leaseFresh(pkg)) return refused("Start package lease lost")
    const lot = store.lots.find((row) => row.org_id === orgId && row.id === pkg.lot_id)
    const home = store.projects.find((row) => row.org_id === orgId && row.id === pkg.project_id)
    if (!lot || !home || lot.project_id !== pkg.project_id) return refused("Starts lot home ancestry differs from package")
    const unsettled = RELEASE_STEPS.filter((key) => {
      const step = store.start_release_steps.find((row) => row.start_package_id === pkg.id && row.step_key === key)
      const skippedPos = key === "pos" && step?.status === "skipped" && step.detail?.purchasing_enabled === false
      return !step || step.error || !step.completed_at || (step.status !== "completed" && !skippedPos)
    })
    if (unsettled.length) return refused(`Release completion is not proven for: ${unsettled.join(", ")}`)
    lot.status = "started"
    Object.assign(home, { start_date: pkg.scheduled_start_date, phase: "delivery" })
    const before = { status: pkg.status }
    Object.assign(pkg, { status: "released", released_at: iso(), released_by: job.payload.actor_id, actual_start_date: pkg.scheduled_start_date })
    ;(store.audit_log ??= []).push({
      org_id: orgId, actor_user_id: job.payload.actor_id, action: "update", entity_type: "start_package", entity_id: pkg.id,
      before_data: before, after_data: { status: "released", actual_start_date: pkg.actual_start_date, job_id: String(jobId) },
      source: "starts.release_published",
    })
    ;(store.events ??= []).push({
      id: eventId, org_id: orgId, event_type: "start.released", entity_type: "start_package", entity_id: pkg.id,
      payload: { project_id: pkg.project_id, lot_id: pkg.lot_id, community_id: pkg.community_id, start_date: pkg.actual_start_date, actor_id: pkg.released_by },
    })
    return ok({ released_at: pkg.released_at, actual_start_date: pkg.actual_start_date, event_id: eventId })
  },

  queue_start_release(args, store) {
    const pkg = store.start_packages.find((row) => row.org_id === args.p_org_id && row.id === args.p_package_id)
    if (!pkg) return refused("Start package not found")
    if (pkg.status !== "ready") return refused("The start package is not ready to release.")
    if (releaseJobs(store, args.p_org_id, pkg.id).some((row) => ["pending", "processing"].includes(row.status))) {
      return refused("This start package is already being released.")
    }
    const others = store.start_packages.filter((row) => row.org_id === args.p_org_id && row.id !== pkg.id
      && row.community_id === pkg.community_id && row.target_week === args.p_target_week && ["releasing", "released"].includes(row.status)).length
    const overSlot = others + 1 > args.p_slot_target
    if (overSlot && !args.p_confirm_over_slot) {
      return ok({ queued: false, target_week: args.p_target_week, target: args.p_slot_target, already_targeted: others })
    }
    Object.assign(pkg, {
      status: "releasing", scheduled_start_date: args.p_scheduled_start_date, target_week: args.p_target_week, released_by: args.p_actor_id,
      metadata: { ...(pkg.metadata ?? {}), release_requested_at: iso(), release_lease_token: null, release_lease_at: null },
    })
    store.start_release_steps ??= []
    for (const stepKey of RELEASE_STEPS) {
      const step = store.start_release_steps.find((row) => row.start_package_id === pkg.id && row.step_key === stepKey)
      if (step && ["completed", "skipped"].includes(step.status)) continue
      const fresh = { status: stepKey === "project" ? "completed" : "pending", completed_at: stepKey === "project" ? iso() : null, started_at: null, error: null }
      if (step) Object.assign(step, fresh)
      else store.start_release_steps.push({ id: randomUUID(), org_id: args.p_org_id, start_package_id: pkg.id, step_key: stepKey, attempt: 0, detail: {}, ...fresh })
    }
    const id = (store.outbox ??= []).reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
    store.outbox.push({
      id, org_id: args.p_org_id, job_type: "start_release", status: "pending", retry_count: 0, run_at: iso(), updated_at: iso(),
      payload: { start_package_id: pkg.id, actor_id: args.p_actor_id }, dedupe_key: `start_release:start_package_id:${pkg.id}`,
    })
    return ok({ queued: true, job_id: String(id), over_slot: overSlot, target_week: args.p_target_week, target: args.p_slot_target, already_targeted: others })
  },

  retry_start_release({ p_org_id: orgId, p_package_id: packageId, p_actor_id: actorId }, store) {
    const pkg = store.start_packages.find((row) => row.org_id === orgId && row.id === packageId)
    if (pkg?.status !== "attention") return refused("Only releases needing attention can be retried.")
    const jobs = releaseJobs(store, orgId, packageId)
    if (jobs.some((row) => ["pending", "processing"].includes(row.status))) return refused("A release attempt is still running for this start package.")
    Object.assign(pkg, { status: "releasing", released_by: actorId })
    clearLease(pkg)
    const job = jobs.at(-1)
    Object.assign(job, {
      status: "pending", retry_count: 0, last_error: null, run_at: iso(), start_claim_token: null, start_job_lease_expires_at: null,
      payload: { ...job.payload, actor_id: actorId },
    })
    return ok({ job_id: String(job.id) })
  },

  cancel_start_release({ p_org_id: orgId, p_package_id: packageId }, store) {
    const pkg = store.start_packages.find((row) => row.org_id === orgId && row.id === packageId)
    if (!pkg || !["releasing", "attention"].includes(pkg.status)) return refused("This release is not cancellable.")
    const steps = store.start_release_steps.filter((row) => row.start_package_id === packageId)
    const settled = (step) => ["completed", "skipped"].includes(step.status)
    const preserved = steps.filter(settled).map((step) => step.step_key).sort()
    const reset = steps.filter((step) => !settled(step)).map((step) => step.step_key).sort()
    for (const job of releaseJobs(store, orgId, packageId)) {
      if (!["pending", "processing"].includes(job.status)) continue
      Object.assign(job, { status: "failed", last_error: "Release cancelled by coordinator", start_claim_token: null, start_job_lease_expires_at: null })
    }
    for (const step of steps) if (!settled(step)) Object.assign(step, { status: "pending", error: null, started_at: null, completed_at: null })
    pkg.status = "ready"
    clearLease(pkg)
    return ok({ preserved, reset })
  },
}

// ---------------------------------------------------------------------------
// The desk's package and gate mutations (20261011060000_starts_desk_mutations).
// Actor and division re-checks are proven against the full schema in
// tests/starts-core-write-fences-db.test.js; these carry the state, readiness
// and records the services rely on.
// ---------------------------------------------------------------------------

function deskPackage(store, args) {
  return store.start_packages.find((row) => row.org_id === args.p_org_id && row.id === args.p_package_id) ?? null
}

function packageGates(store, pkg) {
  return (store.start_package_gates ?? []).filter((gate) => gate.org_id === pkg.org_id && gate.start_package_id === pkg.id)
    .map((gate) => ({ gate, definition: (store.start_gate_definitions ?? []).find((row) => row.id === gate.gate_definition_id) }))
}

function readinessInput(store, pkg) {
  return packageGates(store, pkg).map(({ gate, definition }) => ({ key: definition.key, appliesWhen: definition.applies_when, status: gate.status }))
}

function settleReadiness(store, pkg, actorId, purchasingEnabled) {
  if (!["open", "ready"].includes(pkg.status)) return pkg.status
  const { ready } = startPackageReadiness(readinessInput(store, pkg), { isFinanced: pkg.is_financed, purchasingEnabled })
  const next = ready ? "ready" : "open"
  if (next === pkg.status) return next
  const before = pkg.status
  pkg.status = next
  const eventId = record(store, {
    orgId: pkg.org_id, actorId, entityType: "start_package", entityId: pkg.id, source: "starts.readiness_changed",
    eventType: next === "ready" ? "start_package.ready" : "start_package.not_ready", payload: { status: next }, before: { status: before }, after: { status: next },
  })
  if (next === "ready") queueNotice(store, pkg, "ready", eventId)
  return next
}

/**
 * What start_gate_sql_evidence answers for a source. The real function reads
 * the home's permit application and is proven in tests/permits-db.test.js and
 * tests/starts-core-write-fences-db.test.js; here a fixture names the verdict
 * (`gate_sql_evidence: [{ source, passed }]`).
 */
function sqlEvidence(store, source) {
  return (store.gate_sql_evidence ?? []).some((row) => row.source === source && row.passed)
}

const deskProtocol = {
  start_gate_sql_evidence({ p_source: source }, store) {
    return ok(sqlEvidence(store, source))
  },

  update_start_package({ p_actor_id: actorId, p_patch: patch, p_purchasing_enabled: purchasingEnabled, ...args }, store) {
    const pkg = deskPackage(store, args)
    if (!pkg) return refused("Start package not found")
    if (!["open", "ready"].includes(pkg.status)) return refused("Only open or ready packages can be edited.")
    const before = { ...pkg }
    Object.assign(pkg, patch)
    for (const { gate, definition } of packageGates(store, pkg)) {
      const applies = isGateApplicable({ appliesWhen: definition.applies_when }, { isFinanced: pkg.is_financed, purchasingEnabled })
      if (!applies && gate.status !== "not_applicable") Object.assign(gate, { status: "not_applicable", passed_via: null })
      if (applies && gate.status === "not_applicable") Object.assign(gate, { status: "pending", passed_via: null })
    }
    record(store, { orgId: pkg.org_id, actorId, entityType: "start_package", entityId: pkg.id, source: "starts.package_updated", eventType: "start_package.updated", payload: patch, before, after: { ...pkg } })
    return ok({ status: settleReadiness(store, pkg, actorId, purchasingEnabled) })
  },

  mutate_start_gate({ p_gate_id: gateId, p_actor_id: actorId, p_action: action, p_input: input, p_purchasing_enabled: purchasingEnabled, ...args }, store) {
    const pkg = deskPackage(store, args)
    if (!pkg) return refused("Start package not found")
    if (!["open", "ready"].includes(pkg.status)) return refused("Gates cannot change after release begins.")
    const found = packageGates(store, pkg).find(({ gate }) => gate.id === gateId)
    if (!found) return refused("Start gate not found")
    const { gate, definition } = found
    const before = { ...gate }
    const at = iso()
    if (action === "attest") {
      if (definition.check_kind !== "manual") return refused("Only manual gates can be attested.")
      if (definition.key === "final_approval" && !canAttestFinalApproval(readinessInput(store, pkg), { isFinanced: pkg.is_financed, purchasingEnabled })) {
        return refused("Clear every other readiness gate before final approval.")
      }
      Object.assign(gate, { status: "passed", passed_via: "attested", attested_by: actorId, attested_at: at, evidence_file_id: input.evidence_file_id ?? null, notes: input.notes ?? null, waived_reason: null })
    } else if (action === "waive") {
      Object.assign(gate, { status: "waived", passed_via: "waived", attested_by: actorId, attested_at: at, waived_reason: input.reason })
    } else {
      Object.assign(gate, { status: "pending", passed_via: null, attested_by: null, attested_at: null, waived_reason: null })
    }
    const verb = { attest: "attested", waive: "waived", reopen: "reopened" }[action]
    const eventId = record(store, { orgId: pkg.org_id, actorId, entityType: "start_gate", entityId: gateId, source: `starts.gate_${verb}`, eventType: `start_gate.${verb}`, payload: { start_package_id: pkg.id }, before, after: { ...gate } })
    if (action === "waive") queueNotice(store, pkg, "gate_waived", eventId, input.reason)
    return ok({ status: settleReadiness(store, pkg, actorId, purchasingEnabled) })
  },

  refresh_start_package_gates({ p_actor_id: actorId, p_purchasing_enabled: purchasingEnabled, p_evidence: evidence, ...args }, store) {
    const pkg = deskPackage(store, args)
    if (!pkg) return refused("Start package not found")
    if (!["open", "ready"].includes(pkg.status)) return ok({ status: pkg.status, changed: 0 })
    const changes = []
    for (const { gate, definition } of packageGates(store, pkg)) {
      let next
      if (!isGateApplicable({ appliesWhen: definition.applies_when }, { isFinanced: pkg.is_financed, purchasingEnabled })) next = { status: "not_applicable", passed_via: null }
      else if (definition.check_kind === "auto" && definition.auto_source === "permit_approved") {
        next = sqlEvidence(store, "permit_approved") ? { status: "passed", passed_via: "auto" } : { status: "pending", passed_via: null }
      } else if (gate.status === "waived" || definition.check_kind !== "auto") {
        if (gate.status !== "not_applicable") continue
        next = { status: "pending", passed_via: null }
      } else if (SQL_EVIDENCE_SOURCES.has(definition.auto_source)) {
        next = sqlEvidence(store, definition.auto_source) ? { status: "passed", passed_via: "auto" } : { status: "pending", passed_via: null }
      } else {
        if (typeof evidence[gate.id] !== "boolean") return refused(`Readiness evidence is missing for the ${definition.key} gate; refresh again.`)
        next = evidence[gate.id] ? { status: "passed", passed_via: "auto" } : { status: "pending", passed_via: null }
      }
      if (gate.status !== next.status || (gate.passed_via ?? null) !== next.passed_via) {
        changes.push({ gate_id: gate.id, key: definition.key, from: gate.status, to: next.status })
        Object.assign(gate, next)
      }
    }
    if (changes.length) record(store, { orgId: pkg.org_id, actorId, entityType: "start_package", entityId: pkg.id, source: "starts.gates_refreshed", eventType: "start_gate.refreshed", payload: { gates: changes }, after: { gates: changes } })
    return ok({ status: settleReadiness(store, pkg, actorId, purchasingEnabled), changed: changes.length })
  },

  cancel_start_package({ p_actor_id: actorId, p_reason: reason, ...args }, store) {
    const pkg = deskPackage(store, args)
    if (!pkg) return refused("Start package not found")
    if (["releasing", "released"].includes(pkg.status)) return refused("A releasing or released start package cannot be cancelled.")
    const before = { ...pkg }
    Object.assign(pkg, { status: "cancelled", metadata: { ...(pkg.metadata ?? {}), cancellation_reason: reason.trim() } })
    record(store, { orgId: pkg.org_id, actorId, entityType: "start_package", entityId: pkg.id, source: "starts.package_cancelled", eventType: "start_package.cancelled", payload: { reason: reason.trim() }, before, after: { ...pkg } })
    return ok({ status: "cancelled" })
  },

  retry_start_trade_notice({ p_notice_id: noticeId, p_actor_id: actorId, ...args }, store) {
    const pkg = deskPackage(store, args)
    if (!pkg) return refused("Start package not found")
    if (pkg.status !== "released") return refused("Only released houses can retry trade delivery")
    const notice = (store.outbox ?? []).find((row) => row.org_id === pkg.org_id && String(row.id) === String(noticeId)
      && row.job_type === "start_release_trade_notice" && row.payload?.start_package_id === pkg.id)
    if (!notice) return refused("Trade notice not found")
    if (notice.status !== "failed") return refused("Only failed trade notices can be retried")
    const before = { ...notice }
    Object.assign(notice, { status: "pending", retry_count: 0, last_error: null, run_at: iso(), payload: { ...notice.payload, actor_id: actorId }, start_claim_token: null, start_job_lease_expires_at: null })
    record(store, { orgId: pkg.org_id, actorId, entityType: "start_package", entityId: pkg.id, source: "starts.trade_notice_retried", eventType: "start.trade_notice_retried", payload: { notice_id: String(noticeId), company_id: notice.payload.company_id }, before, after: { status: "pending" } })
    return ok({ notice_id: String(noticeId), status: "pending" })
  },
}

function buildHarness(options = {}) {
  const supabase = createFakeSupabase(options.tables ?? releasingFixture(options), { ...claimProtocol, ...deskProtocol })
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
  buildHarness, installStubs, releasingFixture, stepsByKey, stubModule, succeedingInstantiation,
}
