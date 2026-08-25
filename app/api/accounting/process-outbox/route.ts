import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  ACCOUNTING_JOB_TYPES,
  markAccountingPushExhausted,
  markAccountingPushPermanentlyFailed,
  processAccountingPush,
  type AccountingPushEntityType,
} from "@/lib/services/accounting-sync"
import { classifyQboPermanentFailure } from "@/lib/integrations/accounting/qbo/error-rules"
import { keepAliveAccountingConnections } from "@/lib/services/accounting-connections"
import { logAccounting } from "@/lib/services/accounting-logger"
import { withCronRun } from "@/lib/services/job-runs"

const MAX_RETRIES = 3
const BATCH_SIZE = 25
const TOKEN_KEEPALIVE_BATCH_SIZE = 10
const PROCESSING_TIMEOUT_MINUTES = 20
const ACCOUNTING_OUTBOX_JOB_TYPES = [...ACCOUNTING_JOB_TYPES]

type ClaimedJob = {
  id?: number
  job_id?: number
  org_id: string | null
  job_type: string
  payload?: Record<string, unknown> | null
  retry_count?: number | null
  run_at?: string | null
}

async function processAccountingOutbox(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const keepalive = await keepAliveAccountingConnections(TOKEN_KEEPALIVE_BATCH_SIZE)
  const supabase = createServiceSupabaseClient()

  // Return leases abandoned by a worker that timed out mid-batch, using the
  // same atomic reaper as the generic outbox worker.
  const { data: reaped, error: reapError } = await supabase.rpc("reap_stale_outbox_jobs", {
    p_lease_seconds: PROCESSING_TIMEOUT_MINUTES * 60,
    p_max_attempts: MAX_RETRIES,
    p_job_types: ACCOUNTING_OUTBOX_JOB_TYPES,
  })
  if (reapError) {
    return NextResponse.json({ error: `reap_stale_outbox_jobs failed: ${reapError.message}` }, { status: 500 })
  }
  const reapRow = (Array.isArray(reaped) ? reaped[0] : reaped) as { requeued?: number; exhausted?: number } | null
  const recoveredStale = Number(reapRow?.requeued ?? 0)
  if (recoveredStale > 0) {
    logAccounting("warn", "process_outbox_stale_recovered", { recovered: recoveredStale, exhausted: Number(reapRow?.exhausted ?? 0) })
  }

  // Claims atomically (FOR UPDATE SKIP LOCKED). There is deliberately no
  // select-then-update fallback: that two-statement path is the double-claim
  // race the RPC exists to eliminate, so a missing RPC fails loudly instead.
  const { data: claimedJobs, error } = await supabase.rpc("claim_jobs", {
    job_types: ACCOUNTING_OUTBOX_JOB_TYPES,
    limit_value: BATCH_SIZE,
  })

  if (error) {
    return NextResponse.json({ error: `claim_jobs failed: ${error.message}` }, { status: 500 })
  }

  const jobs = (claimedJobs ?? []) as ClaimedJob[]

  if (!jobs.length) {
    return NextResponse.json({ processed: 0, failed: 0, keepalive, recoveredStale })
  }
  logAccounting("info", "process_outbox_claimed", { jobs: jobs.length })

  let processed = 0
  let failed = 0

  for (const job of jobs) {
    const jobId = job.job_id ?? job.id
    const payload = job.payload ?? {}
    try {
      if (!job.org_id) throw new Error("Missing org_id")
      const normalized = job.job_type.replace(/^qbo_sync_/, "").replace(/^accounting_push_/, "")
      const entityType = normalized as AccountingPushEntityType
      const payloadKey = entityType === "invoice" ? "invoice_id" : entityType === "project_expense" ? "expense_id" : entityType === "vendor_bill" ? "bill_id" : "payment_id"
      const entityId = payload[payloadKey]
      if (typeof entityId !== "string") throw new Error(`Missing ${payloadKey}`)
      const result = await processAccountingPush({ orgId: job.org_id, entityType, entityId })
      if (result.deferred) {
        // Another attempt holds the create claim (15-minute lease). Completed
        // would lose the push forever; re-schedule past the lease instead, and
        // let the normal retry budget stop a claim that never frees.
        const deferRetry = (job.retry_count ?? 0) + 1
        const giveUp = deferRetry >= MAX_RETRIES
        await supabase
          .from("outbox")
          .update({
            status: giveUp ? "failed" : "pending",
            retry_count: deferRetry,
            last_error: "Create claim held by a concurrent sync attempt",
            run_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
          })
          .eq("id", jobId)
        if (giveUp) {
          await markAccountingPushExhausted({
            orgId: job.org_id,
            entityType,
            entityId,
            message: "Create claim was still held by another sync attempt after repeated tries",
          }).catch((markError) => logAccounting("error", "process_outbox_mark_exhausted_failed", { error: String(markError) }))
          failed++
        }
        continue
      }
      await supabase.from("outbox").update({ status: "completed" }).eq("id", jobId)
      processed++
    } catch (err: any) {
      const newRetry = (job.retry_count ?? 0) + 1
      // Some failures are answers, not outages. A QuickBooks 610 for an object
      // somebody deactivated over there will fail identically forever, so it
      // skips the backoff and goes straight to a person with the cure attached.
      const permanent = classifyQboPermanentFailure({
        status: err?.status ?? null,
        faultCode: err?.faultCode ?? null,
        faultDetail: err?.faultDetail ?? null,
        message: err?.message ?? null,
      })
      const shouldRetry = !permanent && newRetry < MAX_RETRIES

      await supabase
        .from("outbox")
        .update({
          status: shouldRetry ? "pending" : "failed",
          retry_count: newRetry,
          last_error: err?.message ?? "Sync failed",
          run_at: shouldRetry
            ? new Date(Date.now() + Math.pow(3, newRetry) * 5 * 60 * 1000).toISOString()
            : job.run_at ?? new Date().toISOString(),
        })
        .eq("id", jobId)

      // Giving up is the moment a human inherits the problem, so it is the
      // moment the transaction has to start saying so.
      if (!shouldRetry && job.org_id) {
        const normalized = job.job_type.replace(/^qbo_sync_/, "").replace(/^accounting_push_/, "")
        const entityType = normalized as AccountingPushEntityType
        const payloadKey = entityType === "invoice" ? "invoice_id" : entityType === "project_expense" ? "expense_id" : entityType === "vendor_bill" ? "bill_id" : "payment_id"
        const entityId = payload[payloadKey]
        if (typeof entityId === "string") {
          const mark = permanent
            ? markAccountingPushPermanentlyFailed({ orgId: job.org_id, entityType, entityId, message: permanent.message })
            : markAccountingPushExhausted({
                orgId: job.org_id,
                entityType,
                entityId,
                message: err?.message ?? "Sync failed",
              })
          await mark.catch((markError) => logAccounting("error", "process_outbox_mark_exhausted_failed", { error: String(markError) }))
        }
      }

      failed++
    }
  }

  return NextResponse.json(
    { ok: failed === 0, processed, failed, keepalive, recoveredStale },
    { status: failed === 0 ? 200 : 207 },
  )
}

export const GET = withCronRun("accounting-process-outbox", processAccountingOutbox)
export const POST = GET
