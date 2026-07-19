import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { normalizeProductTier } from "@/lib/product-tier"
import { instantiatePlanForProject, type PlanInstantiationStep } from "@/lib/services/plan-instantiation"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { generatePurchaseOrders } from "@/lib/services/po-generation"
import { ensureReleaseSlotsForActiveCommunities } from "@/lib/services/even-flow"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { sendScheduleChangeDigestJob, sendTradeLookahead } from "@/lib/services/trade-lookahead"

export const START_PIPELINE_JOB_TYPES = ["start_release", "trade_schedule_change_notice"] as const
const RELEASE_STEPS = ["project", "budget", "schedule", "checklists", "drawings", "pos", "notify_trades", "finalize"] as const
const MAX_JOB_RETRIES = 3
const HEARTBEAT_SECONDS = 45
const STALE_PROCESSING_MINUTES = 3

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
  const result = await instantiatePlanForProject({
    projectId: input.projectId, lotId: input.lotId, housePlanVersionId: input.versionId,
    elevationId: input.elevationId, swing: input.swing, communityId: input.communityId,
    startDate: input.startDate, steps: [step],
  }, undefined)
  if (!result.success) throw new Error(result.errors.join("; ") || `${step} instantiation failed`)
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

async function executeRelease(supabase: SupabaseClient, job: ClaimedJob) {
  const packageId = requiredString(job.payload.start_package_id, "start_package_id")
  const { data: pkg, error: packageError } = await supabase.from("start_packages").select(`
    *, lot:lots!inner(house_plan_version_id,house_plan_elevation_id,swing,status)
  `).eq("org_id", job.org_id).eq("id", packageId).maybeSingle()
  if (packageError || !pkg) throw new Error("Start package not found")
  if (pkg.status === "released") return
  if (pkg.status !== "releasing") throw new Error(`Start package is ${pkg.status}, not releasing`)
  if (!pkg.project_id || !pkg.scheduled_start_date) throw new Error("Release package is missing its project or start date")
  const lot = Array.isArray(pkg.lot) ? pkg.lot[0] : pkg.lot
  if (!lot?.house_plan_version_id) throw new Error("Lot has no pinned plan version")

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
        const [{ error: lotError }, { error: packageFinalizeError }] = await Promise.all([
          supabase.from("lots").update({ status: "started" }).eq("org_id", job.org_id).eq("id", pkg.lot_id),
          supabase.from("start_packages").update({ status: "released", released_at: now, actual_start_date: pkg.scheduled_start_date }).eq("org_id", job.org_id).eq("id", packageId),
          supabase.from("projects").update({ start_date: pkg.scheduled_start_date }).eq("org_id", job.org_id).eq("id", pkg.project_id),
          supabase.from("start_package_gates").update({ status: "passed", passed_via: "auto" }).eq("org_id", job.org_id).eq("start_package_id", packageId)
            .in("gate_definition_id", (await supabase.from("start_gate_definitions").select("id").eq("org_id", job.org_id).in("key", ["budget", "po_set"])).data?.map((row) => row.id) ?? []),
        ])
        if (lotError) throw new Error(`Failed to start lot: ${lotError.message}`)
        if (packageFinalizeError) throw new Error(`Failed to finalize start package: ${packageFinalizeError.message}`)
        await Promise.all([
          recordEvent({ orgId: job.org_id, actorId: requiredString(job.payload.actor_id, "actor_id"), eventType: "start.released", entityType: "start_package", entityId: packageId, payload: { project_id: pkg.project_id, lot_id: pkg.lot_id, community_id: pkg.community_id, start_date: pkg.scheduled_start_date } }),
          notifyAssignedSuper(supabase, job.org_id, pkg.project_id, packageId),
        ])
        detail = { project_id: pkg.project_id, actual_start_date: pkg.scheduled_start_date }
      }
      await updateStep(supabase, job.org_id, packageId, step, { status: "completed", completed_at: new Date().toISOString(), error: null, detail })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await updateStep(supabase, job.org_id, packageId, step, { status: "failed", completed_at: new Date().toISOString(), error: message })
      if (step === "notify_trades") continue
      throw error
    }
  }
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
  const heartbeat = setInterval(() => {
    void supabase.from("outbox").update({ updated_at: new Date().toISOString() }).eq("id", job.job_id)
  }, HEARTBEAT_SECONDS * 1000)
  try {
    const context = await backgroundContext(supabase, job)
    await runWithServiceOrgContext(context, async () => {
      if (job.job_type === "start_release") await executeRelease(supabase, job)
      else await processScheduleChangeNotice(supabase, job)
    })
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
