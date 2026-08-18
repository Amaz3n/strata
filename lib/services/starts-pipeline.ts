import "server-only"

import { randomUUID } from "node:crypto"

import type { SupabaseClient } from "@supabase/supabase-js"

import { normalizeProductTier } from "@/lib/product-tier"
import { instantiatePlanForProject, type PlanInstantiationStep } from "@/lib/services/plan-instantiation"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { generatePurchaseOrders } from "@/lib/services/po-generation"
import { ensureReleaseSlotsForActiveCommunities } from "@/lib/services/even-flow"
import { syncReleaseProducedGates } from "@/lib/services/starts"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { sendScheduleChangeDigestJob, sendTradeLookahead } from "@/lib/services/trade-lookahead"

export const START_PIPELINE_JOB_TYPES = ["start_release", "trade_schedule_change_notice"] as const
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
  if (error || !data) return
  const next = {
    ...asRecord(data.metadata),
    release_lease_token: hold ? token : null,
    release_lease_at: hold ? new Date().toISOString() : null,
  }
  await supabase.from("start_packages").update({ metadata: next })
    .eq("org_id", orgId).eq("id", packageId).eq("metadata->>release_lease_token", token)
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
  const { count, error } = await supabase.from("vendor_price_agreements").select("id", { count: "exact", head: true })
    .eq("org_id", orgId).eq("status", "active").or(`community_id.eq.${communityId},community_id.is.null`)
  if (error) throw new Error(`Failed to inspect price book: ${error.message}`)
  return (count ?? 0) > 0
}

async function notifyAssignedSuper(supabase: SupabaseClient, orgId: string, projectId: string, packageId: string) {
  const [{ data: project }, { data: memberships }] = await Promise.all([
    supabase.from("projects").select("superintendent_id").eq("org_id", orgId).eq("id", projectId).maybeSingle(),
    supabase.from("memberships").select("user_id,role_id").eq("org_id", orgId).eq("status", "active"),
  ])
  const roleIds = Array.from(new Set((memberships ?? []).map((membership) => membership.role_id)))
  const { data: grants } = roleIds.length
    ? await supabase.from("role_permissions").select("role_id").in("role_id", roleIds).eq("permission_key", "start.release")
    : { data: [] }
  const allowedRoles = new Set((grants ?? []).map((grant) => grant.role_id))
  const recipients = new Set((memberships ?? []).filter((membership) => allowedRoles.has(membership.role_id)).map((membership) => membership.user_id))
  if (project?.superintendent_id) recipients.add(project.superintendent_id)
  const notifications = new NotificationService()
  await Promise.allSettled(Array.from(recipients).map((userId) => notifications.createAndQueue({
    orgId, userId, type: "start_released", title: "House released",
    message: "A production house has been released to construction.", projectId,
    entityType: "start_package", entityId: packageId,
  })))
}

type ReleaseOutcome = "completed" | "deferred"

async function executeRelease(supabase: SupabaseClient, job: ClaimedJob, leaseToken: string): Promise<ReleaseOutcome> {
  const packageId = requiredString(job.payload.start_package_id, "start_package_id")
  const { data: pkg, error: packageError } = await supabase.from("start_packages").select(`
    *, lot:lots!inner(house_plan_version_id,house_plan_elevation_id,swing,status)
  `).eq("org_id", job.org_id).eq("id", packageId).maybeSingle()
  if (packageError || !pkg) throw new Error("Start package not found")
  if (pkg.status === "released") return "completed"
  if (pkg.status !== "releasing") throw new Error(`Start package is ${pkg.status}, not releasing`)
  if (!pkg.project_id || !pkg.scheduled_start_date) throw new Error("Release package is missing its project or start date")
  const lot = Array.isArray(pkg.lot) ? pkg.lot[0] : pkg.lot
  if (!lot?.house_plan_version_id) throw new Error("Lot has no pinned plan version")
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
  const { data: ledger, error: ledgerError } = await supabase.from("start_release_steps").select("step_key,status,attempt")
    .eq("org_id", job.org_id).eq("start_package_id", packageId)
  if (ledgerError) throw new Error(`Failed to load release ledger: ${ledgerError.message}`)
  const byStep = new Map((ledger ?? []).map((row) => [row.step_key, row]))

  for (const step of RELEASE_STEPS) {
    const current = byStep.get(step)
    if (current?.status === "completed" || current?.status === "skipped") continue
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
        const { data: assignments } = await supabase.from("schedule_assignments").select("company_id")
          .eq("org_id", job.org_id).eq("project_id", pkg.project_id).not("company_id", "is", null).limit(500)
        const companyIds = Array.from(new Set((assignments ?? []).flatMap((row) => row.company_id ? [row.company_id] : [])))
        const dispatches = await Promise.allSettled(companyIds.map((companyId) => sendTradeLookahead(companyId, { weeks: 3 }, job.org_id)))
        detail = {
          companies: companyIds.length,
          sent: dispatches.filter((result) => result.status === "fulfilled" && result.value.sent).length,
          failed: dispatches.filter((result) => result.status === "rejected").length,
        }
      } else if (step === "finalize") {
        const now = new Date().toISOString()
        // Every one of these is checked. The old version built a four-write
        // Promise.all and destructured two of them, so the project update and
        // the gate write could both fail with the error thrown away while the
        // step was still marked completed.
        const [lotResult, packageResult, projectResult] = await Promise.all([
          supabase.from("lots").update({ status: "started" }).eq("org_id", job.org_id).eq("id", pkg.lot_id),
          supabase.from("start_packages").update({ status: "released", released_at: now, actual_start_date: pkg.scheduled_start_date }).eq("org_id", job.org_id).eq("id", packageId),
          // The house leaves preconstruction here, not when its package opened.
          supabase.from("projects").update({ start_date: pkg.scheduled_start_date, phase: "delivery" }).eq("org_id", job.org_id).eq("id", pkg.project_id),
        ])
        if (lotResult.error) throw new Error(`Failed to start lot: ${lotResult.error.message}`)
        if (packageResult.error) throw new Error(`Failed to finalize start package: ${packageResult.error.message}`)
        if (projectResult.error) throw new Error(`Failed to move the house into delivery: ${projectResult.error.message}`)
        // Derived from what actually landed rather than force-passed: a skipped
        // PO step must not leave an audit trail asserting a PO set exists.
        const producedGates = await syncReleaseProducedGates(supabase, job.org_id, packageId, { projectId: pkg.project_id, lotId: pkg.lot_id })
        await Promise.all([
          recordEvent({ orgId: job.org_id, actorId: requiredString(job.payload.actor_id, "actor_id"), eventType: "start.released", entityType: "start_package", entityId: packageId, payload: { project_id: pkg.project_id, lot_id: pkg.lot_id, community_id: pkg.community_id, start_date: pkg.scheduled_start_date } }),
          notifyAssignedSuper(supabase, job.org_id, pkg.project_id, packageId),
        ])
        detail = { project_id: pkg.project_id, actual_start_date: pkg.scheduled_start_date, gates: producedGates }
      }
      await updateStep(supabase, job.org_id, packageId, step, { status: "completed", completed_at: new Date().toISOString(), error: null, detail })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateStep(supabase, job.org_id, packageId, step, { status: "failed", completed_at: new Date().toISOString(), error: message })
      if (step === "notify_trades") continue
      throw error
    }
  }
  return "completed"
}

async function processScheduleChangeNotice(supabase: SupabaseClient, job: ClaimedJob) {
  await sendScheduleChangeDigestJob(supabase, job)
}

async function markTerminalFailure(supabase: SupabaseClient, job: ClaimedJob, message: string) {
  if (job.job_type !== "start_release") return
  const packageId = typeof job.payload.start_package_id === "string" ? job.payload.start_package_id : null
  if (!packageId) return
  await supabase.from("start_packages").update({ status: "attention" }).eq("org_id", job.org_id).eq("id", packageId)
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
    void supabase.from("outbox").update({ updated_at: new Date().toISOString() }).eq("id", job.job_id)
    if (job.job_type === "start_release" && packageId) {
      void writeReleaseLease(supabase, job.org_id, packageId, leaseToken, true)
    }
  }, HEARTBEAT_SECONDS * 1000)
  try {
    const context = await backgroundContext(supabase, job)
    const outcome = await runWithServiceOrgContext(context, async (): Promise<ReleaseOutcome> => {
      if (job.job_type === "start_release") return await executeRelease(supabase, job, leaseToken)
      await processScheduleChangeNotice(supabase, job)
      return "completed"
    })
    if (outcome === "deferred") {
      // Another worker holds this package. That is not a failure and must not
      // burn a retry — come back once its lease has had time to finish or go stale.
      await supabase.from("outbox").update({
        status: "pending", run_at: new Date(Date.now() + LEASE_RETRY_SECONDS * 1000).toISOString(),
      }).eq("id", job.job_id)
      return true
    }
    await supabase.from("outbox").update({ status: "completed", last_error: null }).eq("id", job.job_id)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retryCount = job.retry_count + 1
    const retry = retryCount < MAX_JOB_RETRIES
    await supabase.from("outbox").update({
      status: retry ? "pending" : "failed", retry_count: retryCount, last_error: message,
      run_at: retry ? new Date(Date.now() + Math.pow(2, retryCount) * 60_000).toISOString() : undefined,
    }).eq("id", job.job_id)
    if (!retry) await markTerminalFailure(supabase, job, message)
    return false
  } finally {
    clearInterval(heartbeat)
    if (job.job_type === "start_release" && packageId) {
      await writeReleaseLease(supabase, job.org_id, packageId, leaseToken, false)
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
  const { count } = await supabase.from("outbox").select("id", { count: "exact", head: true })
    .in("job_type", [...START_PIPELINE_JOB_TYPES]).eq("status", "pending").lte("run_at", new Date().toISOString())
  summary.remaining = count ?? 0
  await ensureReleaseSlotsForActiveCommunities(200)
  return summary
}
