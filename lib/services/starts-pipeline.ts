import "server-only"
import { startsConfirmationId } from "@/lib/starts/confirmation-identity"
import { loadPurchasingEnabledByCommunity } from "@/lib/services/purchasing-readiness"
import { assertProjectConfiguration } from "@/lib/services/configuration-rules"
import { transferLandAtStartForService } from "@/lib/services/books/inventory"

import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { normalizeProductTier } from "@/lib/product-tier"
import { cleanupAbandonedPlanDrawingCopies, instantiatePlanForProject, type PlanInstantiationStep } from "@/lib/services/plan-instantiation"
import { requireOrgContext, runWithServiceOrgContext } from "@/lib/services/context"
import { NotificationService } from "@/lib/services/notifications"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { readAllRows } from "@/lib/land/paging"
import { generatePurchaseOrdersForStartsRelease } from "@/lib/services/po-generation"
import { captureHomeMarginBaseline } from "@/lib/services/home-margin-baselines"
import { captureHomeProductRevisions } from "@/lib/services/home-product-revisions"
import { ensureReleaseSlotsForActiveCommunities } from "@/lib/services/even-flow"
import { assertReleaseGateCompletion, assertStartCommunityAccess, syncReleaseProducedGates } from "@/lib/services/starts"
import { requirePermission } from "@/lib/services/permissions"
import { authorize, getDivisionAccessForUser } from "@/lib/services/authorization"
import { createServiceSupabaseClient, createStartsWorkerSupabaseClient } from "@/lib/supabase/server"
import { runWithServiceSupabaseClient } from "@/lib/supabase/service-client-context"
import { sendScheduleChangeDigestJob, sendTradeLookahead } from "@/lib/services/trade-lookahead"

export const START_PIPELINE_JOB_TYPES = ["start_release", "trade_schedule_change_notice", "start_release_trade_notice", "start_package_notice"] as const
const RELEASE_STEPS = ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"] as const
const HEARTBEAT_SECONDS = 45
/** How long a pre-token (legacy `claim_jobs`) claim may sit silent before it is drained. */
const LEGACY_STALE_PROCESSING_MINUTES = 3
/** How long a worker's claim on a release survives without a heartbeat. */
const LEASE_STALE_MINUTES = 5

/** A row from `claim_starts_jobs`: the claim token is the job's ownership. */
const claimedJobSchema = z.object({
  job_id: z.number().int().positive(),
  org_id: z.string(),
  job_type: z.enum(START_PIPELINE_JOB_TYPES),
  payload: z.record(z.string(), z.unknown()),
  retry_count: z.number().int().nonnegative(),
  claim_token: z.string().uuid(),
})
type ClaimedJob = z.infer<typeof claimedJobSchema>

export interface StartsPipelineSummary {
  processed: number
  failed: number
  remaining: number
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`)
  return value
}

/**
 * Cutover drain. Jobs claimed by the pre-token worker carry no claim token, so
 * the token reaper (`recover_starts_job_leases`) never sees them; once quiet
 * they go back to the queue to be claimed under a token. Retire with
 * `claim_jobs` once production holds no tokenless starts claims.
 */
async function drainLegacyProcessingJobs(service: SupabaseClient) {
  const cutoff = new Date(Date.now() - LEGACY_STALE_PROCESSING_MINUTES * 60_000).toISOString()
  const { error } = await service.from("outbox").update({ status: "pending" })
    .in("job_type", [...START_PIPELINE_JOB_TYPES]).eq("status", "processing")
    .is("start_claim_token", null).lt("updated_at", cutoff)
  if (error) throw new Error(`Failed to drain legacy starts claims: ${error.message}`)
}

async function backgroundContext(supabase: SupabaseClient, job: ClaimedJob) {
  const actorId = requiredString(job.payload.actor_id, "actor_id")
  const [{ data: membership, error: membershipError }, { data: org, error: orgError }] = await Promise.all([
    supabase.from("memberships").select("id").eq("org_id", job.org_id).eq("user_id", actorId).eq("status", "active").maybeSingle(),
    supabase.from("orgs").select("product_tier").eq("id", job.org_id).maybeSingle(),
  ])
  if (membershipError || !membership) throw new Error("The release actor is no longer an active organization member")
  if (orgError || !org) throw new Error("Release organization not found")
  return { supabase, orgId: job.org_id, userId: actorId, productTier: normalizeProductTier(org.product_tier) }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/**
 * Only one worker may walk a package's step ledger at a time.
 *
 * The package lease is held in the name of the job's claim token and moved only
 * by `transition_starts_package_lease`, which checks the claim is current, the
 * actor still may release, and any previous holder has gone stale. Every write
 * this worker makes carries the claim in its request headers, so the release
 * fences re-check the same facts inside each transaction.
 */
async function transitionPackageLease(supabase: SupabaseClient, job: ClaimedJob, action: "acquire" | "heartbeat") {
  const { data, error } = await supabase.rpc("transition_starts_package_lease", {
    p_org_id: job.org_id, p_job_id: job.job_id, p_token: job.claim_token, p_action: action,
  })
  if (error) throw new Error(`Failed to ${action} the start release lease: ${error.message}`)
  return data === true
}

async function updateStep(
  supabase: SupabaseClient,
  orgId: string,
  packageId: string,
  stepKey: typeof RELEASE_STEPS[number],
  patch: Record<string, unknown>,
) {
  const { error } = await supabase.from("start_release_steps").update(patch)
    .eq("org_id", orgId).eq("start_package_id", packageId).eq("step_key", stepKey)
  if (error) throw new Error(`Failed to update ${stepKey} release step: ${error.message}`)
}

async function runInstantiationStep(
  step: PlanInstantiationStep,
  input: { projectId: string; lotId: string; versionId: string; elevationId: string | null; swing: "left" | "right" | null; communityId: string; startDate: string },
) {
  // `resume: true` is load-bearing. The instantiation ledger lives on the
  // project and the release ledger lives on `start_release_steps`; they are two
  // writes, so a crash between them leaves a step marked in one and pending in
  // the other. Without this the retry threw "already instantiated" forever, the
  // package parked in `attention`, and no amount of retrying could clear it.
  const result = await instantiatePlanForProject({
    projectId: input.projectId, lotId: input.lotId, housePlanVersionId: input.versionId,
    elevationId: input.elevationId, swing: input.swing, communityId: input.communityId,
    startDate: input.startDate, steps: [step], resume: true,
  }, undefined)
  if (!result.success) throw new Error(result.errors.join("; ") || `${step} instantiation failed`)
  if (result.skipped.includes(step)) return { already_instantiated: true }
  const output = result[step]
  return output && typeof output === "object" ? output as Record<string, unknown> : {}
}

async function purchasingEnabled(supabase: SupabaseClient, orgId: string, communityId: string) {
  return (await loadPurchasingEnabledByCommunity(supabase, orgId, [communityId])).get(communityId) ?? false
}

/** Every active member who holds start.release through a role or a grant. */
async function startReleaseAudience(supabase: SupabaseClient, orgId: string) {
  const roster = await readAllRows((from, to) => supabase.from("memberships").select("id,user_id,role_id")
    .eq("org_id", orgId).eq("status", "active").order("id").range(from, to),
  { cap: 100001, label: "Failed to read release notification audience" })
  if (roster.truncated) throw new Error("Release notification audience exceeds the supported limit")
  const memberships = roster.rows
  const roleIds = Array.from(new Set(memberships.map((membership) => membership.role_id)))
  const grants: { role_id: string }[] = []
  for (let offset = 0; offset < roleIds.length; offset += 100) {
    const result = await readAllRows((from, to) => supabase.from("role_permissions").select("role_id,permission_key")
      .in("role_id", roleIds.slice(offset, offset + 100)).in("permission_key", ["start.release", "*"])
      .order("role_id").order("permission_key").range(from, to), { cap: 1001, label: "Failed to read release notification roles" })
    if (result.truncated) throw new Error("Release notification roles exceed the supported limit")
    grants.push(...result.rows)
  }
  const allowedRoles = new Set(grants.map((grant) => grant.role_id))
  const recipients = new Set(memberships.filter((membership) => allowedRoles.has(membership.role_id)).map((membership) => membership.user_id))
  const usersByMembership = new Map(memberships.map(row => [row.id, row.user_id]))
  const membershipIds = Array.from(usersByMembership.keys())
  for (let offset = 0; offset < membershipIds.length; offset += 100) {
    const result = await readAllRows((from, to) => supabase.from("membership_permission_overrides").select("membership_id,permission_key")
      .in("membership_id", membershipIds.slice(offset, offset + 100)).eq("effect", "grant").in("permission_key", ["start.release", "*"])
      .order("membership_id").order("permission_key").range(from, to), { cap: 1001, label: "Failed to read release notification overrides" })
    if (result.truncated) throw new Error("Release notification overrides exceed the supported limit")
    for (const row of result.rows) {
      const userId = usersByMembership.get(row.membership_id)
      if (userId) recipients.add(userId)
    }
  }
  return recipients
}

async function notifyAssignedSuper(supabase: SupabaseClient, orgId: string, projectId: string, packageId: string) {
  const [{ data: project, error: projectError }, recipients] = await Promise.all([
    supabase.from("projects").select("superintendent_id").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    startReleaseAudience(supabase, orgId),
  ])
  if (projectError || !project) throw new Error(`Failed to read release notification home: ${projectError?.message ?? "Home unavailable"}`)
  if (project.superintendent_id) recipients.add(project.superintendent_id)
  const notifications = new NotificationService()
  const ids = Array.from(recipients)
  for (let offset = 0; offset < ids.length; offset += 20) {
    await Promise.all(ids.slice(offset, offset + 20).map(async (userId) => {
      const access = await authorize({ orgId, userId, projectId, permission: userId === project.superintendent_id ? "start.read" : "start.release" })
      if (!access.allowed) return
      await notifications.createAndQueue({
        orgId, userId, type: "start_released", title: "House released",
        message: "A production house has been released to construction.", projectId,
        entityType: "start_package", entityId: packageId,
        eventId: startsConfirmationId(orgId, packageId, "event"),
      }, { idempotencyId: startsConfirmationId(orgId, packageId, "notification", userId) })
    }))
  }
}

/**
 * The release's baseline and notifications. `publish_start_release` wrote the
 * `start.released` event in the transaction that released the house, and this
 * job — still claimed — is the durable intent to notify: it completes only
 * after this runs, and a retry of a released package runs only this. Every
 * recipient has one stable notification identity, so a replay never
 * double-sends.
 */
async function confirmReleasedPackage(supabase: SupabaseClient, job: ClaimedJob, pkg: { id: string; project_id: string | null }) {
  if (!pkg.project_id) throw new Error("Released package is missing its confirmation scope")
  // What the house was released at: the budget the release just instantiated
  // against the agreement it was sold at (or its asking price, unsold), and the
  // plan, elevation and option revisions it was built from. Each captured once;
  // a retried confirmation finds them already there.
  const baseline = { orgId: job.org_id, projectId: pkg.project_id, stage: "release" as const, actorId: requiredString(job.payload.actor_id, "actor_id") }
  await Promise.all([captureHomeMarginBaseline(baseline), captureHomeProductRevisions(baseline)])
  await notifyAssignedSuper(supabase, job.org_id, pkg.project_id, pkg.id)
}

type ReleaseOutcome = "completed" | "deferred"

class ReleaseLeaseLostError extends Error {}

async function assertReleaseLease(supabase: SupabaseClient, job: ClaimedJob, packageId: string) {
  const token = job.claim_token
  const [{ data: pkg, error: packageError }, { data: queuedJob, error: jobError }] = await Promise.all([
    supabase.from("start_packages").select("status,metadata").eq("org_id", job.org_id).eq("id", packageId).maybeSingle(),
    supabase.from("outbox").select("status,start_claim_token,start_job_lease_expires_at").eq("org_id", job.org_id).eq("id", job.job_id).maybeSingle(),
  ])
  if (packageError || jobError) throw new ReleaseLeaseLostError(`Failed to verify release ownership: ${packageError?.message ?? jobError?.message}`)
  const metadata = asRecord(pkg?.metadata)
  const renewedAt = typeof metadata.release_lease_at === "string" ? Date.parse(metadata.release_lease_at) : Number.NaN
  if (pkg?.status !== "releasing" || metadata.release_lease_token !== token || !Number.isFinite(renewedAt)
    || Date.now() - renewedAt >= LEASE_STALE_MINUTES * 60_000 || queuedJob?.status !== "processing"
    || queuedJob.start_claim_token !== token || typeof queuedJob.start_job_lease_expires_at !== "string"
    || Date.parse(queuedJob.start_job_lease_expires_at) <= Date.now()) {
    throw new ReleaseLeaseLostError("Release ownership changed or expired; this worker must stop")
  }
}

async function executeRelease(supabase: SupabaseClient, service: SupabaseClient, job: ClaimedJob): Promise<ReleaseOutcome> {
  const packageId = requiredString(job.payload.start_package_id, "start_package_id")
  const { data: pkg, error: packageError } = await supabase.from("start_packages").select(`
    *, lot:lots!inner(house_plan_version_id,house_plan_elevation_id,swing,status,division_id)
  `).eq("org_id", job.org_id).eq("id", packageId).maybeSingle()
  if (packageError || !pkg) throw new Error("Start package not found")
  if (pkg.status === "released") {
    await confirmReleasedPackage(supabase, job, pkg)
    return "completed"
  }
  if (pkg.status !== "releasing") throw new Error(`Start package is ${pkg.status}, not releasing`)
  if (!pkg.project_id || !pkg.scheduled_start_date) throw new Error("Release package is missing its project or start date")
  const lot = Array.isArray(pkg.lot) ? pkg.lot[0] : pkg.lot
  if (!lot?.house_plan_version_id) throw new Error("Lot has no pinned plan version")
  const access = await assertStartCommunityAccess(supabase, job.org_id, pkg.community_id)
  if (access.assignedOnly && (!lot.division_id || !access.divisionIds.includes(lot.division_id))) throw new Error("Release lot is outside your division access")
  if (!await transitionPackageLease(supabase, job, "acquire")) return "deferred"

  const { data: version } = await supabase.from("house_plan_versions").select("status")
    .eq("org_id", job.org_id).eq("id", lot.house_plan_version_id).maybeSingle()
  if (version?.status !== "released") throw new Error("Pinned plan version is no longer released")
  const usePurchasing = await purchasingEnabled(supabase, job.org_id, pkg.community_id)
  const input = {
    projectId: pkg.project_id, lotId: pkg.lot_id, versionId: lot.house_plan_version_id,
    elevationId: lot.house_plan_elevation_id ?? null,
    swing: lot.swing === "left" || lot.swing === "right" ? lot.swing : null,
    communityId: pkg.community_id, startDate: pkg.scheduled_start_date,
  }
  const { data: ledger, error: ledgerError } = await supabase.from("start_release_steps").select("step_key,status,attempt,detail")
    .eq("org_id", job.org_id).eq("start_package_id", packageId)
  if (ledgerError) throw new Error(`Failed to load release ledger: ${ledgerError.message}`)
  const byStep = new Map((ledger ?? []).map((row) => [row.step_key, row]))

  for (const step of RELEASE_STEPS) {
    const current = byStep.get(step)
    if (current?.status === "completed" || (step === "pos" && !usePurchasing && current?.status === "skipped"
      && asRecord(current.detail).purchasing_enabled === false)) continue
    await assertReleaseLease(supabase, job, packageId)
    await updateStep(supabase, job.org_id, packageId, step, {
      status: "running", attempt: Number(current?.attempt ?? 0) + 1,
      started_at: new Date().toISOString(), completed_at: null, error: null,
    })
    try {
      let detail: Record<string, unknown> = {}
      if (step === "project") {
        detail = { project_id: pkg.project_id }
      } else if (step === "budget") {
        detail = usePurchasing ? { delegated_to: "pos" } : await runInstantiationStep("budget", input)
      } else if (step === "schedule" || step === "checklists" || step === "drawings") {
        detail = await runInstantiationStep(step, input)
      } else if (step === "pos") {
        if (!usePurchasing) {
          await updateStep(supabase, job.org_id, packageId, step, { status: "skipped", completed_at: new Date().toISOString(), detail: { purchasing_enabled: false } })
          continue
        }
        const generated = await generatePurchaseOrdersForStartsRelease({ projectId: pkg.project_id, orgId: job.org_id })
        detail = {
          run_id: generated.runId, po_count: generated.purchaseOrders.length,
          total_cents: generated.purchaseOrders.reduce((sum, po) => sum + po.totalCents, 0),
          exceptions: generated.exceptions.length,
        }
      } else if (step === "notify_trades") {
        await assertProjectConfiguration(job.org_id, pkg.project_id)
        const companies = new Set<string>()
        for (let offset = 0; ; offset += 500) {
          const { data: assignments, error: assignmentError } = await supabase.from("schedule_assignments").select("id,company_id")
            .eq("org_id", job.org_id).eq("project_id", pkg.project_id).not("company_id", "is", null)
            .order("id").range(offset, offset + 499)
          if (assignmentError) throw new Error(`Failed to read release trade assignments: ${assignmentError.message}`)
          if (!assignments) throw new Error("Release trade assignments unavailable")
          for (const row of assignments) if (row.company_id) companies.add(row.company_id)
          if (assignments.length < 500) break
          if (offset + assignments.length >= 100_000) throw new Error("Release trade assignments exceed the supported limit")
        }
        const companyIds = Array.from(companies)
        const existing = await readAllRows((from, to) => supabase.from("outbox").select("id,payload")
          .eq("org_id", job.org_id).eq("job_type", "start_release_trade_notice")
          .eq("payload->>start_package_id", packageId).order("id").range(from, to),
        { cap: 100001, label: "Failed to inspect release trade notices" })
        if (existing.truncated) throw new Error("Release trade notices exceed the supported limit")
        const queuedCompanies = new Set(existing.rows.flatMap((row) => {
          const companyId = asRecord(row.payload).company_id
          return typeof companyId === "string" ? [companyId] : []
        }))
        let queued = 0
        for (let offset = 0; offset < companyIds.length; offset += 20) {
          await assertReleaseLease(supabase, job, packageId)
          const results = await Promise.all(companyIds.slice(offset, offset + 20).map((companyId) => queuedCompanies.has(companyId)
            ? Promise.resolve({ enqueued: false as const, reason: "duplicate" as const }) : enqueueOutboxJob({
            orgId: job.org_id, jobType: "start_release_trade_notice",
            payload: { start_package_id: packageId, company_id: companyId, actor_id: requiredString(job.payload.actor_id, "actor_id") },
            dedupeByPayloadKeys: ["start_package_id", "company_id"],
          })))
          if (results.some((result) => !result.enqueued && result.reason !== "duplicate")) throw new Error("Failed to queue release trade notices")
          queued += results.length
        }
        detail = { companies: companyIds.length, queued }
      } else if (step === "finalize") {
        await assertProjectConfiguration(job.org_id, pkg.project_id)
        await transferLandAtStartForService(job.org_id, pkg.lot_id, pkg.scheduled_start_date, requiredString(job.payload.actor_id, "actor_id"))
        await assertReleaseLease(supabase, job, packageId)
        // The lot starts and the house leaves preconstruction at publication,
        // in the transaction that releases the package — not here, where a
        // later failure would leave a started lot on an unreleased package.
        // Derived from what actually landed rather than force-passed: a skipped
        // PO step must not leave an audit trail asserting a PO set exists.
        const producedGates = await syncReleaseProducedGates(supabase, job.org_id, packageId, { projectId: pkg.project_id, lotId: pkg.lot_id })
        await assertReleaseLease(supabase, job, packageId)
        detail = { project_id: pkg.project_id, gates: producedGates }
      }
      await assertReleaseLease(supabase, job, packageId)
      await updateStep(supabase, job.org_id, packageId, step, { status: "completed", completed_at: new Date().toISOString(), error: null, detail })
    } catch (error) {
      if (error instanceof ReleaseLeaseLostError) throw error
      await assertReleaseLease(supabase, job, packageId)
      const message = error instanceof Error ? error.message : String(error)
      await updateStep(supabase, job.org_id, packageId, step, { status: "failed", completed_at: new Date().toISOString(), error: message })
      throw error
    }
  }
  // Publish only after the artifacts and durable step ledger have succeeded.
  await assertReleaseLease(supabase, job, packageId)
  await assertReleaseGateCompletion(supabase, job.org_id, packageId, {
    projectId: pkg.project_id, lotId: pkg.lot_id, communityId: pkg.community_id, startDate: pkg.scheduled_start_date, purchasingEnabled: usePurchasing,
  })
  await assertReleaseLease(supabase, job, packageId)
  // The step ledger is proven settled, the lot starts, the house enters
  // delivery and the package turns released — with its audit, its event and
  // their search reindex — in one transaction that re-checks the claim, the
  // package lease and the actor. It runs on the service client: it fences
  // itself, and the claim fences refuse the reindex jobs it enqueues.
  const { error: publishError } = await service.rpc("publish_start_release", {
    p_org_id: job.org_id, p_job_id: job.job_id, p_token: job.claim_token,
    p_event_id: startsConfirmationId(job.org_id, packageId, "event"),
  })
  if (publishError) throw new Error(`Failed to publish start release: ${publishError.message}`)
  await confirmReleasedPackage(supabase, job, pkg)
  return "completed"
}

async function processScheduleChangeNotice(supabase: SupabaseClient, job: ClaimedJob) {
  const projectId = requiredString(job.payload.project_id, "project_id")
  const context = await requireOrgContext(job.org_id)
  const access = await getDivisionAccessForUser(context)
  const { data: project, error } = await supabase.from("projects").select("division_id")
    .eq("org_id", job.org_id).eq("id", projectId).maybeSingle()
  if (error || !project) throw new Error("Schedule notice project not found")
  if (access.assignedOnly && (!project.division_id || !access.divisionIds.includes(project.division_id))) throw new Error("Schedule notice project is outside your division access")
  await sendScheduleChangeDigestJob(supabase, job)
}

async function processReleaseTradeNotice(supabase: SupabaseClient, job: ClaimedJob): Promise<ReleaseOutcome> {
  const packageId = requiredString(job.payload.start_package_id, "start_package_id")
  const companyId = requiredString(job.payload.company_id, "company_id")
  const { data: pkg, error } = await supabase.from("start_packages").select("status,community_id")
    .eq("org_id", job.org_id).eq("id", packageId).maybeSingle()
  if (error || !pkg) throw new Error(`Failed to load notice release: ${error?.message ?? "Start package not found"}`)
  await assertStartCommunityAccess(supabase, job.org_id, pkg.community_id)
  if (pkg.status === "releasing" || pkg.status === "attention") return "deferred"
  if (pkg.status !== "released") throw new Error("Trade notice package is not released")
  await sendTradeLookahead(companyId, { weeks: 3, releaseNoticeKey: packageId }, job.org_id)
  return "completed"
}

type ClaimTransition = "heartbeat" | "defer" | "complete" | "retry"

/**
 * Every change to a claimed job goes through `transition_starts_job_lease`,
 * which acts only for the current, unexpired claim token. `false` means this
 * worker no longer owns the job (the reaper reclaimed it, or a coordinator
 * cancelled the release) and must not report an outcome for it.
 */
async function transitionClaim(service: SupabaseClient, job: ClaimedJob, action: ClaimTransition, failure?: string) {
  const { data, error } = await service.rpc("transition_starts_job_lease", {
    p_org_id: job.org_id, p_id: job.job_id, p_token: job.claim_token, p_action: action, p_error: failure ?? null,
  })
  if (error) throw new Error(`Failed to persist starts job ${action}: ${error.message}`)
  return data === true
}

const packageNoticeSchema = z.object({
  start_package_id: z.string().uuid(),
  kind: z.enum(["ready", "gate_waived", "release_failed"]),
  event_id: z.string().uuid(),
  message: z.string().nullable(),
})

const PACKAGE_NOTICES = {
  ready: { type: "start_package_ready", title: "Start package ready", message: "A start package has cleared its readiness gates." },
  gate_waived: { type: "start_gate_waived", title: "Start gate waived", message: null },
  release_failed: { type: "start_release_failed", title: "Start release failed", message: null },
} as const

/**
 * A package notice is the notification intent the transaction that changed the
 * package queued with it — a gate waived, a package turned ready, a release
 * parked after its final failure (the claim transition or the lease reaper
 * writes that one with the park). It names the event it announces, and each
 * recipient's notification identity is derived from that event, so a replay of
 * this job never double-sends. It runs as the system: the change it reports has
 * already committed, and a release can fail precisely because its actor lost
 * access.
 */
async function sendPackageNotice(service: SupabaseClient, job: ClaimedJob) {
  const notice = packageNoticeSchema.parse(job.payload)
  const [{ data: pkg, error }, recipients] = await Promise.all([
    service.from("start_packages").select("project_id").eq("org_id", job.org_id).eq("id", notice.start_package_id).maybeSingle(),
    startReleaseAudience(service, job.org_id),
  ])
  if (error || !pkg) throw new Error(`Failed to read the start package notice: ${error?.message ?? "Start package not found"}`)
  const template = PACKAGE_NOTICES[notice.kind]
  const projectId = typeof pkg.project_id === "string" ? pkg.project_id : undefined
  const notifications = new NotificationService()
  const ids = Array.from(recipients)
  for (let offset = 0; offset < ids.length; offset += 20) {
    await Promise.all(ids.slice(offset, offset + 20).map(async (userId) => {
      const access = await authorize({ orgId: job.org_id, userId, projectId, permission: "start.release" })
      if (!access.allowed) return
      await notifications.createAndQueue({
        orgId: job.org_id, userId, type: template.type, title: template.title,
        message: template.message ?? notice.message ?? template.title, projectId,
        entityType: "start_package", entityId: notice.start_package_id, eventId: notice.event_id,
      }, { idempotencyId: startsConfirmationId(job.org_id, `${notice.start_package_id}:${notice.kind}:${notice.event_id}`, "notification", userId) })
    }))
  }
}

async function runClaimedJob(supabase: SupabaseClient, service: SupabaseClient, job: ClaimedJob): Promise<ReleaseOutcome> {
  if (job.job_type === "start_package_notice") {
    await sendPackageNotice(service, job)
    return "completed"
  }
  const context = await backgroundContext(supabase, job)
  return runWithServiceSupabaseClient(supabase, () => runWithServiceOrgContext(context, async (): Promise<ReleaseOutcome> => {
    await requirePermission(job.job_type === "start_release" ? "start.release" : "start.write", context)
    if (job.job_type === "start_release") return await executeRelease(supabase, service, job)
    if (job.job_type === "start_release_trade_notice") return await processReleaseTradeNotice(supabase, job)
    await processScheduleChangeNotice(supabase, job)
    return "completed"
  }))
}

/**
 * A release runs on a client that carries its claim (`x-starts-job-id` /
 * `x-starts-claim-token`), so every package, ledger, home, lot, artifact and
 * child-job write is fenced to this claim, this package's lease and the
 * actor's current authority. Trade notices write nothing the release fences
 * own; their ownership is the claim token on their own job.
 */
async function processJob(service: SupabaseClient, job: ClaimedJob) {
  const supabase = job.job_type === "start_release" ? createStartsWorkerSupabaseClient(job.job_id, job.claim_token) : service
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!await transitionClaim(service, job, "heartbeat")) return
      if (job.job_type === "start_release") await transitionPackageLease(service, job, "heartbeat")
    })().catch((error) => console.warn("[starts-pipeline] Failed to renew starts claim:", error))
  }, HEARTBEAT_SECONDS * 1000)
  try {
    const outcome = await runClaimedJob(supabase, service, job)
    // Another worker holds the package: not a failure, and it must not burn a
    // retry — the claim comes back once that lease has finished or gone stale.
    const owned = await transitionClaim(service, job, outcome === "deferred" ? "defer" : "complete")
    if (!owned) console.warn("[starts-pipeline] Starts claim was lost before its outcome was recorded:", job.job_id)
    return owned
  } catch (error) {
    if (error instanceof ReleaseLeaseLostError) {
      console.warn("[starts-pipeline] Stopping worker after release ownership loss:", job.job_id, error.message)
      return false
    }
    // A lost completion write lands here too: the retry re-enters a released
    // package, which only re-runs its idempotent confirmation. The final retry
    // parks the package in that transition, with its failure event, audit and
    // notice — and only when this claim held the package lease or nobody did.
    await transitionClaim(service, job, "retry", error instanceof Error ? error.message : String(error))
    return false
  } finally {
    clearInterval(heartbeat)
  }
}

export async function runStartsPipeline(options: { deadlineMs?: number } = {}): Promise<StartsPipelineSummary> {
  const service = createServiceSupabaseClient()
  const deadline = options.deadlineMs ?? Date.now() + 240_000
  const summary = { processed: 0, failed: 0, remaining: 0 }
  await drainLegacyProcessingJobs(service)
  const { error: recoverError } = await service.rpc("recover_starts_job_leases", { p_limit: 500 })
  if (recoverError) throw new Error(`Failed to recover expired starts claims: ${recoverError.message}`)
  while (Date.now() < deadline) {
    const { data, error } = await service.rpc("claim_starts_jobs", { p_limit: 2 })
    if (error) throw new Error(`Failed to claim starts jobs: ${error.message}`)
    const jobs = z.array(claimedJobSchema).parse(data ?? [])
    if (!jobs.length) break
    for (const job of jobs) {
      if (await processJob(service, job)) summary.processed += 1
      else summary.failed += 1
      if (Date.now() >= deadline) break
    }
  }
  const { count, error: countError } = await service.from("outbox").select("id", { count: "exact", head: true })
    .in("job_type", [...START_PIPELINE_JOB_TYPES]).eq("status", "pending").lte("run_at", new Date().toISOString())
  if (countError || count === null) throw new Error(`Failed to count remaining starts jobs: ${countError?.message ?? "Count unavailable"}`)
  summary.remaining = count
  await ensureReleaseSlotsForActiveCommunities(200)
  await cleanupAbandonedPlanDrawingCopies()
  return summary
}
