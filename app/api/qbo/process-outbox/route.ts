import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { syncInvoiceToQBO, syncPaymentToQBO } from "@/lib/services/qbo-sync"
import { logQBO } from "@/lib/services/qbo-logger"

const CRON_SECRET = process.env.CRON_SECRET
const MAX_RETRIES = 3
const BATCH_SIZE = 25

type ClaimedJob = {
  id?: number
  job_id?: number
  org_id: string | null
  job_type: string
  payload?: Record<string, unknown> | null
  retry_count?: number | null
  run_at?: string | null
}

export async function POST(request: NextRequest) {
  const auth = request.headers.get("x-cron-secret")
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
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
    return NextResponse.json({ processed: 0 })
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

  return NextResponse.json({ processed, failed })
}
