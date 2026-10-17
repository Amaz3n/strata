import "server-only"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { commitImportBatch } from "@/lib/services/imports"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Failed units of the production pipelines, for the operator: each one says
 * what failed, where it lives, and the safe way back — the shape Books gives a
 * source that did not post (`books/posting-status.ts`: the error, its cure, a
 * link). Read across every organization from the platform Ops console.
 *
 * Recovery here is limited to what is safe for an operator to do without being
 * a member of the organization: putting back a job whose handler is replayable
 * (the worker itself retries it this way), and committing a failed Open-WIP
 * cutover again, which resumes from its receipts. Everything else is the
 * organization's own action on its workbench, and the unit links there.
 */
type FailurePipeline = "starts" | "imports" | "signing" | "notifications" | "warranty"

export interface PipelineFailureUnit {
  key: string
  orgId: string
  orgName: string | null
  /** What the unit is, in words: "Start release · Lot 12, Maple Ridge". */
  label: string
  error: string | null
  failedAt: string
  /** The request or job that produced it, to read with its audit rows and events. */
  correlationId: string | null
  /** Where the unit lives (the organization's own workbench, or the platform import page). */
  href: string | null
  /** The documented safe recovery, always shown. */
  cure: string
  /** An operator action that performs that recovery here, when one is safe. */
  recovery: { kind: "requeue_job"; jobId: number } | { kind: "commit_again"; batchId: string } | null
}

export interface PipelineFailureGroup {
  pipeline: FailurePipeline
  label: string
  /** Exact, independent of the listing cap. */
  total: number
  units: PipelineFailureUnit[]
}

const UNIT_LIMIT = 25
const STARTS_JOB_TYPES = ["start_release", "trade_schedule_change_notice", "start_release_trade_notice", "start_package_notice"]
const SIGNING_JOB_TYPES = ["send_esign_invitation", "send_esign_reminder", "send_esign_executed_email", "finalize_document_signing", "process_esign_execution_side_effects"]
const NOTIFICATION_JOB_TYPES = ["deliver_notification", "deliver_push", "send_daily_log_mention_email"]
const WARRANTY_JOB_TYPES = ["warranty_enroll_coverage"]
/** Families whose handlers the worker already replays on failure, so an operator requeue is the same action. */
const REQUEUEABLE_JOB_TYPES = [...SIGNING_JOB_TYPES, ...NOTIFICATION_JOB_TYPES, ...WARRANTY_JOB_TYPES]
const IMPORT_STALL_MINUTES = 30

const CURES = {
  releaseAttention: "The organization's starts coordinator opens the start package: Retry release requeues it from the step that failed; Cancel release keeps what already landed on the house and returns the unfinished steps.",
  startsJob: "Retry from the start package: a trade notice has its own Retry on the package's notices; a release is retried with Retry release. Starts jobs are never requeued from here, because their claims and package state move together.",
  importFailedOpenWip: "Commit again. The cutover resumes from its receipts: homes already built are adopted, never duplicated, and only the rest are built.",
  importFailed: "Review the batch's rows on the import page, fix or skip what failed, and stage the corrected file. Records the batch already committed are kept.",
  importStalledOpenWip: "Nothing to do by hand: once the claim lapses the next outbox run resumes the cutover from its receipts. If it keeps stalling, Cancel it on the import page and commit again.",
  importStalled: "The commit stopped without an outcome. Review the batch on the import page before staging it again; records it committed are kept.",
  signing: "Fix the cause in the error, then requeue: the job goes back with a full retry budget, exactly as the worker retries it. An invitation or executed-copy email can be sent again if the failure came after the provider accepted it.",
  notifications: "Fix the cause in the error (provider settings, recipient address), then requeue it with a full retry budget.",
  warranty: "Requeue the enrollment: it is keyed to the home and its effective date, so a requeue enrolls the coverage once.",
} as const

type OrgName = { name: string | null } | Array<{ name: string | null }> | null
const orgName = (org: OrgName) => (Array.isArray(org) ? org[0]?.name : org?.name) ?? null
const text = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null)

async function failedJobs(types: string[]) {
  const supabase = createServiceSupabaseClient()
  const [count, rows] = await Promise.all([
    supabase.from("outbox").select("id", { count: "exact", head: true }).eq("status", "failed").in("job_type", types),
    supabase.from("outbox").select("id, org_id, job_type, payload, last_error, updated_at, correlation_id, org:orgs(name)")
      .eq("status", "failed").in("job_type", types).order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(UNIT_LIMIT),
  ])
  if (count.error) throw new Error(`Unable to count failed jobs: ${count.error.message}`)
  if (rows.error) throw new Error(`Unable to list failed jobs: ${rows.error.message}`)
  return { total: count.count ?? 0, rows: rows.data ?? [] }
}

async function startsFailures(): Promise<PipelineFailureGroup> {
  const supabase = createServiceSupabaseClient()
  const [attentionCount, attention, jobs] = await Promise.all([
    supabase.from("start_packages").select("id", { count: "exact", head: true }).eq("status", "attention"),
    supabase.from("start_packages").select("id, org_id, updated_at, lot:lots(lot_number), community:communities(name), org:orgs(name)")
      .eq("status", "attention").order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(UNIT_LIMIT),
    failedJobs(STARTS_JOB_TYPES),
  ])
  if (attentionCount.error || attention.error) throw new Error(`Unable to list releases needing attention: ${(attentionCount.error ?? attention.error)?.message}`)
  const packages = attention.data ?? []
  const failures = packages.length
    ? await supabase.from("events").select("entity_id, payload, correlation_id, created_at").eq("event_type", "start.release_failed")
      .in("entity_id", packages.map((row) => row.id)).order("created_at", { ascending: false })
    : { data: [], error: null }
  if (failures.error) throw new Error(`Unable to read release failures: ${failures.error.message}`)
  const lastFailure = new Map<string, { error: string | null; correlationId: string | null }>()
  for (const event of failures.data ?? []) {
    if (!lastFailure.has(event.entity_id)) lastFailure.set(event.entity_id, { error: text((event.payload as Record<string, unknown>)?.error), correlationId: event.correlation_id ?? null })
  }
  const units: PipelineFailureUnit[] = packages.map((row) => {
    const lot = Array.isArray(row.lot) ? row.lot[0] : row.lot
    const community = Array.isArray(row.community) ? row.community[0] : row.community
    const failure = lastFailure.get(row.id)
    return {
      key: `package:${row.id}`, orgId: row.org_id, orgName: orgName(row.org),
      label: `Start release · Lot ${lot?.lot_number ?? "?"}${community?.name ? `, ${community.name}` : ""}`,
      error: failure?.error ?? null, failedAt: row.updated_at, correlationId: failure?.correlationId ?? null,
      href: `/starts/${row.id}`, cure: CURES.releaseAttention, recovery: null,
    }
  })
  for (const job of jobs.rows) {
    const payload = (job.payload ?? {}) as Record<string, unknown>
    const packageId = text(payload.start_package_id) ?? text(payload.package_id)
    units.push({
      key: `job:${job.id}`, orgId: job.org_id, orgName: orgName(job.org),
      label: `${job.job_type.replaceAll("_", " ")} · job ${job.id}`,
      error: job.last_error ?? null, failedAt: job.updated_at, correlationId: job.correlation_id ?? null,
      href: packageId ? `/starts/${packageId}` : null, cure: CURES.startsJob, recovery: null,
    })
  }
  return { pipeline: "starts", label: "Starts", total: (attentionCount.count ?? 0) + jobs.total, units: units.slice(0, UNIT_LIMIT * 2) }
}

async function importFailures(): Promise<PipelineFailureGroup> {
  const supabase = createServiceSupabaseClient()
  const stalledBefore = new Date(Date.now() - IMPORT_STALL_MINUTES * 60_000).toISOString()
  // Failed (not cancelled: a cancellation is an operator's decision, not a failure), or committing with no progress.
  const filter = `and(status.eq.failed,report->cancelled.is.null),and(status.eq.committing,importer.eq.open_wip,commit_lease_expires_at.lt.${stalledBefore}),and(status.eq.committing,importer.neq.open_wip,updated_at.lt.${stalledBefore})`
  const [count, rows] = await Promise.all([
    supabase.from("import_batches").select("id", { count: "exact", head: true }).or(filter),
    supabase.from("import_batches").select("id, org_id, importer, status, source_filename, report, updated_at, org:orgs(name)")
      .or(filter).order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(UNIT_LIMIT),
  ])
  if (count.error || rows.error) throw new Error(`Unable to list failed imports: ${(count.error ?? rows.error)?.message}`)
  const units = (rows.data ?? []).map((row): PipelineFailureUnit => {
    const report = (row.report ?? {}) as Record<string, unknown>
    const openWip = row.importer === "open_wip"
    const failed = row.status === "failed"
    return {
      key: `batch:${row.id}`, orgId: row.org_id, orgName: orgName(row.org),
      label: `${row.importer.replaceAll("_", " ")} · ${row.source_filename ?? "untitled file"}${failed ? "" : " (stalled)"}`,
      error: text(report.commit_error) ?? text(report.error) ?? (failed ? null : `No progress for over ${IMPORT_STALL_MINUTES} minutes`),
      failedAt: row.updated_at, correlationId: null,
      href: `/admin/customers/${row.org_id}/onboarding/import/${row.importer}?batch=${row.id}`,
      cure: failed ? (openWip ? CURES.importFailedOpenWip : CURES.importFailed) : (openWip ? CURES.importStalledOpenWip : CURES.importStalled),
      recovery: failed && openWip ? { kind: "commit_again", batchId: row.id } : null,
    }
  })
  return { pipeline: "imports", label: "Imports", total: count.count ?? 0, units }
}

async function jobFailures(pipeline: FailurePipeline, label: string, types: string[], cure: string): Promise<PipelineFailureGroup> {
  const { total, rows } = await failedJobs(types)
  return {
    pipeline, label, total,
    units: rows.map((job) => {
      const payload = (job.payload ?? {}) as Record<string, unknown>
      const subject = text(payload.signing_request_id) ? `request ${String(payload.signing_request_id).slice(0, 8)}`
        : text(payload.notificationId) ?? text(payload.notification_id) ? `notification ${String(payload.notificationId ?? payload.notification_id).slice(0, 8)}`
          : text(payload.project_id) ? `home ${String(payload.project_id).slice(0, 8)}` : null
      return {
        key: `job:${job.id}`, orgId: job.org_id, orgName: orgName(job.org),
        label: `${job.job_type.replaceAll("_", " ")} · job ${job.id}${subject ? ` · ${subject}` : ""}`,
        error: job.last_error ?? null, failedAt: job.updated_at, correlationId: job.correlation_id ?? null,
        href: pipeline === "warranty" && text(payload.project_id) ? `/projects/${payload.project_id}` : null,
        cure, recovery: { kind: "requeue_job", jobId: Number(job.id) },
      }
    }),
  }
}

/** Every production pipeline's failed units, newest first, capped per pipeline with exact totals. */
export async function listPipelineFailures(): Promise<PipelineFailureGroup[]> {
  await requireAnyPlatformPermission(["platform.support.read"])
  return Promise.all([
    startsFailures(),
    importFailures(),
    jobFailures("signing", "Signing", SIGNING_JOB_TYPES, CURES.signing),
    jobFailures("notifications", "Notifications", NOTIFICATION_JOB_TYPES, CURES.notifications),
    jobFailures("warranty", "Warranty", WARRANTY_JOB_TYPES, CURES.warranty),
  ])
}

/**
 * Puts one failed job of a replayable family back with a full retry budget —
 * the plain retry kept `retry_count`, so a job at its limit got one attempt and
 * failed straight back. Refuses any other family: those recover on their own
 * workbench, where the state that moves with the job moves too.
 */
export async function requeueFailedPipelineJob(jobId: number) {
  const id = z.number().int().positive().parse(jobId)
  const operator = await requireAnyPlatformPermission(["platform.support.write"])
  const supabase = createServiceSupabaseClient()
  const { data: requeued, error } = await supabase.from("outbox")
    .update({ status: "pending", retry_count: 0, last_error: null, run_at: new Date().toISOString() })
    .eq("id", id).eq("status", "failed").in("job_type", REQUEUEABLE_JOB_TYPES)
    .select("id, org_id, job_type").maybeSingle()
  if (error) throw new Error(`Unable to requeue the job: ${error.message}`)
  if (!requeued) throw new Error("This job is not a failed signing, notification or warranty job; it may have been requeued already")
  // Outbox ids are integers, not the uuid an entity id holds, so the job is named in the payload.
  await Promise.all([
    recordEvent({ orgId: requeued.org_id, actorId: operator.id, eventType: "outbox_job_requeued", entityType: "outbox", payload: { job_id: requeued.id, job_type: requeued.job_type, source: "platform_ops" } }),
    recordAudit({ orgId: requeued.org_id, actorId: operator.id, action: "update", entityType: "outbox", before: { job_id: requeued.id, status: "failed" }, after: { job_id: requeued.id, status: "pending", retry_count: 0, job_type: requeued.job_type }, source: "platform_ops" }),
  ])
  return { jobId: Number(requeued.id), orgId: String(requeued.org_id), jobType: String(requeued.job_type) }
}

/** Commits a failed Open-WIP cutover again; it resumes from its receipts (the onboarding workbench's own commit). */
export async function recommitFailedCutover(input: { orgId: string; batchId: string }) {
  const parsed = z.object({ orgId: z.string().uuid(), batchId: z.string().uuid() }).parse(input)
  return commitImportBatch(parsed.batchId, { platformOrgId: parsed.orgId, expectedImporter: "open_wip" })
}
