import "server-only"
import { startsConfirmationId } from "@/lib/starts/confirmation-identity"
import { loadPurchasingEnabledByCommunity } from "@/lib/services/purchasing-readiness"
import { assertProjectConfiguration } from "@/lib/services/configuration-rules"
import { transferLandAtStartForService } from "@/lib/services/books/inventory"

import { randomUUID } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"

import { normalizeProductTier } from "@/lib/product-tier"
import { instantiatePlanForProject, type PlanInstantiationStep } from "@/lib/services/plan-instantiation"
import { requireOrgContext, runWithServiceOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { readAllRows } from "@/lib/land/paging"
import { generatePurchaseOrders } from "@/lib/services/po-generation"
import { ensureReleaseSlotsForActiveCommunities } from "@/lib/services/even-flow"
import { assertReleaseGateCompletion, assertStartCommunityAccess, syncReleaseProducedGates } from "@/lib/services/starts"
import { requirePermission } from "@/lib/services/permissions"
import { authorize, getDivisionAccessForUser } from "@/lib/services/authorization"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { runWithServiceSupabaseClient } from "@/lib/supabase/service-client-context"
import { sendScheduleChangeDigestJob, sendTradeLookahead } from "@/lib/services/trade-lookahead"

export const START_PIPELINE_JOB_TYPES = ["start_release", "trade_schedule_change_notice", "start_release_trade_notice"] as const
const RELEASE_STEPS = ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"] as const
const MAX_JOB_RETRIES = 3
const HEARTBEAT_SECONDS = 45
const STALE_PROCESSING_MINUTES = 3
/** How long a worker's claim on a release survives without a heartbeat. */
const LEASE_STALE_MINUTES = 5
/** How long a deferred release waits for the current worker to finish. */
const LEASE_RETRY_SECONDS = 60

interface ClaimedJob {
  job_id: number
  org_id: string
  job_type: typeof START_PIPELINE_JOB_TYPES[number]
  payload: Record<string, unknown>
  retry_count: number
}

export interface StartsPipelineSummary {
  processed: number
  failed: number
  remaining: number
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} is required`)
  return value
}

async function resetStaleProcessingJobs(supabase: SupabaseClient) {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MINUTES * 60_000).toISOString()
  const { error } = await supabase.from("outbox").update({ status: "pending" })
    .in("job_type", [...START_PIPELINE_JOB_TYPES]).eq("status", "processing").lt("updated_at", cutoff)
  if (error) console.warn("[starts-pipeline] Failed to reclaim stale jobs:", error.message)
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
 * `claim_jobs` plus the stale-processing reclaim plus an out-of-band
 * `triggerStartsPipeline` alongside the five-minute cron can all hand the same
 * release to two workers. PO generation fingerprints its inputs so the money
 * path survives that; schedule instantiation, checklist seeding and the step
 * ledger do not — two workers would build the house twice.
 *
 * The lease is a conditional status transition: we CAS on the token we observed,
 * so a worker that took it between our read and our write wins and we back off.
 * A lease with no heartbeat for `LEASE_STALE_MINUTES` is takeable, which is how
 * a worker killed mid-release stops blocking its own retry.
 */
function leaseState(metadata: unknown, token: string) {
  const record = asRecord(metadata)
  const held = typeof record.release_lease_token === "string" ? record.release_lease_token : null
  const heldAt = typeof record.release_lease_at === "string" ? Date.parse(record.release_lease_at) : Number.NaN
  const expired = !Number.isFinite(heldAt) || Date.now() - heldAt > LEASE_STALE_MINUTES * 60_000
  return { held, takeable: held === null || held === token || expired }
}

async function acquireReleaseLease(
  supabase: SupabaseClient,
  orgId: string,
  packageId: string,
  metadata: unknown,
  token: string,
) {
  const { held, takeable } = leaseState(metadata, token)
  if (!takeable) return false
  const next = { ...asRecord(metadata), release_lease_token: token, release_lease_at: new Date().toISOString() }
  const base = supabase.from("start_packages").update({ metadata: next })
    .eq("org_id", orgId).eq("id", packageId).eq("status", "releasing")
  const { data, error } = await (held === null
    ? base.is("metadata->>release_lease_token", null)
    : base.eq("metadata->>release_lease_token", held)).select("id")
  if (error) throw new Error(`Failed to lease the start release: ${error.message}`)
  return (data ?? []).length > 0
}

async function writeReleaseLease(
  supabase: SupabaseClient,
  orgId: string,
  packageId: string,
  token: string,
  hold: boolean,
) {
  const { data, error } = await supabase.from("start_packages").select("metadata")
    .eq("org_id", orgId).eq("id", packageId).maybeSingle()
  if (error) throw new Error(`Failed to read release lease: ${error.message}`)
  if (!data) return
  const metadata = asRecord(data.metadata)
  if (metadata.release_lease_token !== token) return
  if (hold) {
    const renewedAt = typeof metadata.release_lease_at === "string" ? Date.parse(metadata.release_lease_at) : Number.NaN
    if (!Number.isFinite(renewedAt) || Date.now() - renewedAt >= LEASE_STALE_MINUTES * 60_000) {
      throw new ReleaseLeaseLostError("Expired package lease cannot be renewed")
    }
  }
  const next = {
    ...asRecord(data.metadata),
    release_lease_token: hold ? token : null,
    release_lease_at: hold ? new Date().toISOString() : null,
  }
  let query = supabase.from("start_packages").update({ metadata: next })
    .eq("org_id", orgId).eq("id", packageId).eq("metadata->>release_lease_token", token)
  if (hold) query = query.eq("metadata->>release_lease_at", String(metadata.release_lease_at))
  const { data: updated, error: updateError } = await query.select("id")
  if (updateError) throw new Error(`Failed to write release lease: ${updateError.message}`)
  if (hold && updated?.length !== 1) throw new ReleaseLeaseLostError("Package lease changed during renewal")
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

async function notifyAssignedSuper(supabase: SupabaseClient, orgId: string, projectId: string, packageId: string) {
  const [{ data: project, error: projectError }, roster] = await Promise.all([
    supabase.from("projects").select("superintendent_id").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    readAllRows((from, to) => supabase.from("memberships").select("id,user_id,role_id")
      .eq("org_id", orgId).eq("status", "active").order("id").range(from, to),
    { cap: 100001, label: "Failed to read release notification audience" }),
  ])
  if (projectError || !project) throw new Error(`Failed to read release notification home: ${projectError?.message ?? "Home unavailable"}`)
  if (roster.truncated) throw new Error("Release notification audience exceeds the supported limit")
  const memberships = roster.rows
  const roleIds = Array.from(new Set((memberships ?? []).map((membership) => membership.role_id)))
  const grants: { role_id: string }[] = []
  for (let offset = 0; offset < roleIds.length; offset += 100) {
    const result = await readAllRows((from, to) => supabase.from("role_permissions").select("role_id,permission_key")
      .in("role_id", roleIds.slice(offset, offset + 100)).in("permission_key", ["start.release", "*"])
      .order("role_id").order("permission_key").range(from, to), { cap: 1001, label: "Failed to read release notification roles" })
    if (result.truncated) throw new Error("Release notification roles exceed the supported limit")
    grants.push(...result.rows)
  }
  const allowedRoles = new Set((grants ?? []).map((grant) => grant.role_id))
  const recipients = new Set((memberships ?? []).filter((membership) => allowedRoles.has(membership.role_id)).map((membership) => membership.user_id))
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
  if (project?.superintendent_id) recipients.add(project.superintendent_id)
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

async function confirmReleasedPackage(supabase: SupabaseClient, job: ClaimedJob, pkg: {
  id: string; project_id: string | null; lot_id: string; community_id: string; actual_start_date: string | null; released_by?: string | null;
}) {
  if (!pkg.project_id || !pkg.actual_start_date) throw new Error("Released package is missing its confirmation scope")
  await recordEvent({ orgId: job.org_id, actorId: pkg.released_by ?? requiredString(job.payload.actor_id, "actor_id"), eventType: "start.released",
    idempotencyId: startsConfirmationId(job.org_id, pkg.id, "event"),
    entityType: "start_package", entityId: pkg.id,
    payload: { project_id: pkg.project_id, lot_id: pkg.lot_id, community_id: pkg.community_id, start_date: pkg.actual_start_date } })
  await notifyAssignedSuper(supabase, job.org_id, pkg.project_id, pkg.id)
}

type ReleaseOutcome = "completed" | "deferred"

class ReleaseLeaseLostError extends Error {}

async function assertReleaseLease(supabase: SupabaseClient, job: ClaimedJob, packageId: string, token: string) {
  const [{ data: pkg, error: packageError }, { data: queuedJob, error: jobError }] = await Promise.all([
    supabase.from("start_packages").select("status,metadata").eq("org_id", job.org_id).eq("id", packageId).maybeSingle(),
    supabase.from("outbox").select("status").eq("org_id", job.org_id).eq("id", job.job_id).maybeSingle(),
  ])
  if (packageError || jobError) throw new ReleaseLeaseLostError(`Failed to verify release ownership: ${packageError?.message ?? jobError?.message}`)
  const metadata = asRecord(pkg?.metadata)
  const renewedAt = typeof metadata.release_lease_at === "string" ? Date.parse(metadata.release_lease_at) : Number.NaN
  if (pkg?.status !== "releasing" || metadata.release_lease_token !== token || !Number.isFinite(renewedAt)
    || Date.now() - renewedAt >= LEASE_STALE_MINUTES * 60_000 || queuedJob?.status !== "processing") {
    throw new ReleaseLeaseLostError("Release ownership changed or expired; this worker must stop")
  }
}

async function assertReleaseCompletion(
  supabase: SupabaseClient, orgId: string, packageId: string,
  projectId: string, lotId: string, startDate: string, usePurchasing: boolean,
) {
  const [ledger, project, lot] = await Promise.all([
    supabase.from("start_release_steps").select("step_key,status,completed_at,error,detail")
      .eq("org_id", orgId).eq("start_package_id", packageId),
    supabase.from("projects").select("phase,start_date").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    supabase.from("lots").select("status,project_id").eq("org_id", orgId).eq("id", lotId).maybeSingle(),
  ])
  if (ledger.error || project.error || lot.error) {
    throw new Error(`Failed to verify release completion: ${ledger.error?.message ?? project.error?.message ?? lot.error?.message}`)
  }
  if (!ledger.data || !project.data || !lot.data) throw new Error("Release completion records unavailable")
  const byStep = new Map(ledger.data.map(row => [row.step_key, row]))
  if (byStep.size !== ledger.data.length) throw new Error("Release completion ledger contains duplicate steps")
  for (const key of RELEASE_STEPS) {
    const step = byStep.get(key)
    const allowedSkip = key === "pos" && !usePurchasing && step?.status === "skipped"
      && asRecord(step.detail).purchasing_enabled === false
    if (!step || (step.status !== "completed" && !allowedSkip) || step.error
      || typeof step.completed_at !== "string" || !Number.isFinite(Date.parse(step.completed_at))) {
      throw new Error(`Release completion is not proven for the ${key} step`)
    }
  }
  if (project.data.phase !== "delivery" || project.data.start_date !== startDate
    || lot.data.status !== "started" || lot.data.project_id !== projectId) {
    throw new Error("Release home and lot do not match the completed start")
  }
}

async function executeRelease(supabase: SupabaseClient, job: ClaimedJob, leaseToken: string): Promise<ReleaseOutcome> {
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
  if (!await acquireReleaseLease(supabase, job.org_id, packageId, pkg.metadata, leaseToken)) return "deferred"

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
    await assertReleaseLease(supabase, job, packageId, leaseToken)
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
        const generated = await generatePurchaseOrders({ projectId: pkg.project_id, mode: "commit", orgId: job.org_id })
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
          await assertReleaseLease(supabase, job, packageId, leaseToken)
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
        await assertReleaseLease(supabase, job, packageId, leaseToken)
        // Every one of these is checked. The old version built a four-write
        // Promise.all and destructured two of them, so the project update and
        // the gate write could both fail with the error thrown away while the
        // step was still marked completed.
        const [lotResult, projectResult] = await Promise.all([
          supabase.from("lots").update({ status: "started" }).eq("org_id", job.org_id).eq("id", pkg.lot_id),
          // The house leaves preconstruction here, not when its package opened.
          supabase.from("projects").update({ start_date: pkg.scheduled_start_date, phase: "delivery" }).eq("org_id", job.org_id).eq("id", pkg.project_id),
        ])
        if (lotResult.error) throw new Error(`Failed to start lot: ${lotResult.error.message}`)
        if (projectResult.error) throw new Error(`Failed to move the house into delivery: ${projectResult.error.message}`)
        // Derived from what actually landed rather than force-passed: a skipped
        // PO step must not leave an audit trail asserting a PO set exists.
        const producedGates = await syncReleaseProducedGates(supabase, job.org_id, packageId, { projectId: pkg.project_id, lotId: pkg.lot_id })
        await assertReleaseLease(supabase, job, packageId, leaseToken)
        detail = { project_id: pkg.project_id, actual_start_date: pkg.scheduled_start_date, gates: producedGates }
      }
      await assertReleaseLease(supabase, job, packageId, leaseToken)
      await updateStep(supabase, job.org_id, packageId, step, { status: "completed", completed_at: new Date().toISOString(), error: null, detail })
    } catch (error) {
      if (error instanceof ReleaseLeaseLostError) throw error
      await assertReleaseLease(supabase, job, packageId, leaseToken)
      const message = error instanceof Error ? error.message : String(error)
      await updateStep(supabase, job.org_id, packageId, step, { status: "failed", completed_at: new Date().toISOString(), error: message })
      throw error
    }
  }
  // Publish only after the artifacts and durable step ledger have succeeded.
  // A failed final write leaves a releasing package that can resume without
  // treating a partial project/lot update as an already completed release.
  await assertReleaseLease(supabase, job, packageId, leaseToken)
  await assertReleaseCompletion(supabase, job.org_id, packageId, pkg.project_id, pkg.lot_id, pkg.scheduled_start_date, usePurchasing)
  await assertReleaseGateCompletion(supabase, job.org_id, packageId, {
    projectId: pkg.project_id, lotId: pkg.lot_id, communityId: pkg.community_id, startDate: pkg.scheduled_start_date, purchasingEnabled: usePurchasing,
  })
  await assertReleaseLease(supabase, job, packageId, leaseToken)
  const { data: published, error: publishError } = await supabase.from("start_packages")
    .update({ status: "released", released_at: new Date().toISOString(), released_by: requiredString(job.payload.actor_id, "actor_id"), actual_start_date: pkg.scheduled_start_date })
    .eq("org_id", job.org_id).eq("id", packageId).eq("status", "releasing")
    .eq("metadata->>release_lease_token", leaseToken).select("id")
  if (publishError || published?.length !== 1) throw new Error(`Failed to publish start release: ${publishError?.message ?? "Release lease or package state changed"}`)
  await confirmReleasedPackage(supabase, job, { ...pkg, actual_start_date: pkg.scheduled_start_date, released_by: requiredString(job.payload.actor_id, "actor_id") })
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

async function transitionJob(supabase: SupabaseClient, job: ClaimedJob, patch: Record<string, unknown>) {
  const { data, error } = await supabase.from("outbox").update(patch)
    .eq("org_id", job.org_id).eq("id", job.job_id).eq("status", "processing")
    .select("id")
  if (error || data?.length !== 1) throw new Error(`Failed to persist starts job ${patch.status}: ${error?.message ?? "Job is no longer processing"}`)
}

async function markTerminalFailure(supabase: SupabaseClient, job: ClaimedJob, message: string, leaseToken: string) {
  if (job.job_type !== "start_release") return
  const packageId = typeof job.payload.start_package_id === "string" ? job.payload.start_package_id : null
  if (!packageId) return
  const { data: parked, error: parkError } = await supabase.from("start_packages").update({ status: "attention" })
    .eq("org_id", job.org_id).eq("id", packageId).eq("status", "releasing")
    .or(`metadata->>release_lease_token.is.null,metadata->>release_lease_token.eq.${leaseToken}`).select("id")
  if (parkError) throw new Error(`Failed to flag unsuccessful start release: ${parkError.message}`)
  // A completion-write failure can exhaust retries after the house was released.
  // Preserve that release and do not emit a false house-release failure event.
  if (!parked?.length) return
  await recordEvent({ orgId: job.org_id, actorId: typeof job.payload.actor_id === "string" ? job.payload.actor_id : null, eventType: "start.release_failed", entityType: "start_package", entityId: packageId, payload: { error: message } })
  const { data: recipients } = await supabase.from("memberships").select("user_id,role:roles!inner(permissions:role_permissions!inner(permission_key))")
    .eq("org_id", job.org_id).eq("status", "active").eq("role.permissions.permission_key", "start.release")
  const notifications = new NotificationService()
  await Promise.allSettled(Array.from(new Set((recipients ?? []).map((row) => row.user_id))).map((userId) => notifications.createAndQueue({
    orgId: job.org_id, userId, type: "start_release_failed", title: "Start release failed",
    message, entityType: "start_package", entityId: packageId,
  })))
}

async function processJob(supabase: SupabaseClient, job: ClaimedJob) {
  const leaseToken = randomUUID()
  const packageId = typeof job.payload.start_package_id === "string" ? job.payload.start_package_id : null
  const heartbeat = setInterval(() => {
    // PostgREST builders are lazy: voiding a builder does not send a request.
    void (async () => {
      const { error } = await supabase.from("outbox").update({ updated_at: new Date().toISOString() })
        .eq("org_id", job.org_id).eq("id", job.job_id).eq("status", "processing")
      if (error) throw new Error(error.message)
    })().catch((error) => console.warn("[starts-pipeline] Failed to renew job heartbeat:", error))
    if (job.job_type === "start_release" && packageId) {
      void writeReleaseLease(supabase, job.org_id, packageId, leaseToken, true)
        .catch((error) => console.warn("[starts-pipeline] Failed to renew package lease:", error))
    }
  }, HEARTBEAT_SECONDS * 1000)
  try {
    const context = await backgroundContext(supabase, job)
    const outcome = await runWithServiceSupabaseClient(supabase, () => runWithServiceOrgContext(context, async (): Promise<ReleaseOutcome> => {
      await requirePermission(job.job_type === "start_release" ? "start.release" : "start.write", context)
      if (job.job_type === "start_release") return await executeRelease(supabase, job, leaseToken)
      if (job.job_type === "start_release_trade_notice") return await processReleaseTradeNotice(supabase, job)
      await processScheduleChangeNotice(supabase, job)
      return "completed"
    }))
    if (outcome === "deferred") {
      // Another worker holds this package. That is not a failure and must not
      // burn a retry — come back once its lease has had time to finish or go stale.
      await transitionJob(supabase, job, {
        status: "pending", run_at: new Date(Date.now() + LEASE_RETRY_SECONDS * 1000).toISOString(),
      })
      return true
    }
    await transitionJob(supabase, job, { status: "completed", last_error: null })
    return true
  } catch (error) {
    if (error instanceof ReleaseLeaseLostError) {
      console.warn("[starts-pipeline] Stopping worker after release ownership loss:", job.job_id, error.message)
      return false
    }
    const message = error instanceof Error ? error.message : String(error)
    const retryCount = job.retry_count + 1
    const retry = retryCount < MAX_JOB_RETRIES
    await transitionJob(supabase, job, {
      status: retry ? "pending" : "failed", retry_count: retryCount, last_error: message,
      run_at: retry ? new Date(Date.now() + Math.pow(2, retryCount) * 60_000).toISOString() : undefined,
    })
    if (!retry) await markTerminalFailure(supabase, job, message, leaseToken)
    return false
  } finally {
    clearInterval(heartbeat)
    if (job.job_type === "start_release" && packageId) {
      await writeReleaseLease(supabase, job.org_id, packageId, leaseToken, false)
        .catch((error) => console.warn("[starts-pipeline] Failed to clear package lease:", error))
    }
  }
}

export async function runStartsPipeline(options: { deadlineMs?: number } = {}): Promise<StartsPipelineSummary> {
  const supabase = createServiceSupabaseClient()
  const deadline = options.deadlineMs ?? Date.now() + 240_000
  const summary = { processed: 0, failed: 0, remaining: 0 }
  await resetStaleProcessingJobs(supabase)
  while (Date.now() < deadline) {
    const { data, error } = await supabase.rpc("claim_jobs", { job_types: [...START_PIPELINE_JOB_TYPES], limit_value: 2 })
    if (error) throw new Error(`Failed to claim starts jobs: ${error.message}`)
    const jobs = (data ?? []) as ClaimedJob[]
    if (!jobs.length) break
    for (const job of jobs) {
      if (await processJob(supabase, job)) summary.processed += 1
      else summary.failed += 1
      if (Date.now() >= deadline) break
    }
  }
  const { count, error: countError } = await supabase.from("outbox").select("id", { count: "exact", head: true })
    .in("job_type", [...START_PIPELINE_JOB_TYPES]).eq("status", "pending").lte("run_at", new Date().toISOString())
  if (countError || count === null) throw new Error(`Failed to count remaining starts jobs: ${countError?.message ?? "Count unavailable"}`)
  summary.remaining = count
  await ensureReleaseSlotsForActiveCommunities(200)
  return summary
}
