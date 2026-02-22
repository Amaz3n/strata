import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { syncInvoiceToQBO, syncPaymentToQBO } from "@/lib/services/qbo-sync"
import { refreshQBOConnectionsDueForKeepalive } from "@/lib/services/qbo-connection"
import { logQBO } from "@/lib/services/qbo-logger"

const CRON_SECRET = process.env.CRON_SECRET
const MAX_RETRIES = 3
const BATCH_SIZE = 25
const TOKEN_KEEPALIVE_BATCH_SIZE = 10
const PROCESSING_TIMEOUT_MINUTES = 20

type ClaimedJob = {
  id?: number
  job_id?: number
  org_id: string | null
  job_type: string
  payload?: Record<string, unknown> | null
  retry_count?: number | null
  run_at?: string | null
}

function isAuthorizedCronRequest(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) return true

  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")
  const isVercelCron = request.headers.get("x-vercel-cron") === "1"

  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  if (CRON_SECRET) {
    return secretOk
  }

  return isVercelCron
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const keepalive = await refreshQBOConnectionsDueForKeepalive(TOKEN_KEEPALIVE_BATCH_SIZE)
  const supabase = createServiceSupabaseClient()
  const staleCutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000).toISOString()
  let recoveredStale = 0

  const { data: recoveredRows, error: recoveredError } = await supabase
    .from("outbox")
    .update({
      status: "pending",
      run_at: new Date().toISOString(),
      last_error: "Recovered stale processing job",
    })
    .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
    .eq("status", "processing")
    .lt("updated_at", staleCutoff)
    .select("id")

  if (recoveredError) {
    logQBO("warn", "process_outbox_stale_recovery_failed", { error: recoveredError.message })
  } else {
    recoveredStale = recoveredRows?.length ?? 0
    if (recoveredStale > 0) {
      logQBO("warn", "process_outbox_stale_recovered", { recovered: recoveredStale })
    }
  }

  const { data: claimedJobs, error } = await supabase.rpc("claim_jobs", {
    job_types: ["qbo_sync_invoice", "qbo_sync_payment"],
    limit_value: BATCH_SIZE,
  })

  if (error && !error.message.toLowerCase().includes("claim_jobs")) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let jobs = (claimedJobs ?? []) as ClaimedJob[]
  if (error && jobs.length === 0) {
    const now = new Date().toISOString()
    const { data: fallbackJobs, error: fallbackError } = await supabase
      .from("outbox")
      .select("id, org_id, job_type, payload, retry_count, run_at")
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
      .eq("status", "pending")
      .lte("run_at", now)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE)

    if (fallbackError) {
      return NextResponse.json({ error: fallbackError.message }, { status: 500 })
    }

    const jobIds = (fallbackJobs ?? []).map((j) => j.id)
    if (jobIds.length > 0) {
      await supabase.from("outbox").update({ status: "processing" }).in("id", jobIds).eq("status", "pending")
    }
    jobs = (fallbackJobs ?? []) as ClaimedJob[]
  }

  if (!jobs.length) {
    return NextResponse.json({ processed: 0, failed: 0, keepalive, recoveredStale })
  }
  logQBO("info", "process_outbox_claimed", { jobs: jobs.length })

  let processed = 0
  let failed = 0

  for (const job of jobs) {
    const jobId = job.job_id ?? job.id
    const payload = job.payload ?? {}
    try {
      if (job.job_type === "qbo_sync_invoice") {
        const invoiceId = payload.invoice_id as string | undefined
        if (!invoiceId || !job.org_id) throw new Error("Missing invoice_id or org_id")
        const result = await syncInvoiceToQBO(invoiceId, job.org_id)
        if (result.success) {
          await supabase.from("outbox").update({ status: "completed" }).eq("id", jobId)
          processed++
        } else {
          throw new Error(result.error ?? "Unknown sync error")
        }
      } else if (job.job_type === "qbo_sync_payment") {
        const paymentId = payload.payment_id as string | undefined
        if (!paymentId || !job.org_id) throw new Error("Missing payment_id or org_id")
        const result = await syncPaymentToQBO(paymentId, job.org_id)
        if (result.success) {
          await supabase.from("outbox").update({ status: "completed" }).eq("id", jobId)
          processed++
        } else {
          throw new Error(result.error ?? "Unknown sync error")
        }
      } else {
        await supabase.from("outbox").update({ status: "failed", last_error: "Unknown job type" }).eq("id", jobId)
        failed++
      }
    } catch (err: any) {
      const newRetry = (job.retry_count ?? 0) + 1
      const shouldRetry = newRetry < MAX_RETRIES

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

      failed++
    }
  }

  return NextResponse.json({ processed, failed, keepalive, recoveredStale })
}
