import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { syncInvoiceToQBO, syncPaymentToQBO } from "@/lib/services/qbo-sync"

const CRON_SECRET = process.env.CRON_SECRET
const MAX_RETRIES = 3
const BATCH_SIZE = 25

export async function POST(request: NextRequest) {
  const auth = request.headers.get("x-cron-secret")
  if (!CRON_SECRET || auth !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const { data: jobs, error } = await supabase
    .from("outbox")
    .select("*")
    .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
    .eq("status", "pending")
    .lte("run_at", now)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!jobs?.length) {
    return NextResponse.json({ processed: 0 })
  }

  const jobIds = jobs.map((j) => j.id)
  await supabase.from("outbox").update({ status: "processing" }).in("id", jobIds)

  let processed = 0
  let failed = 0

  for (const job of jobs) {
    const payload = (job as any).payload ?? {}
    try {
      if (job.job_type === "qbo_sync_invoice") {
        const invoiceId = payload.invoice_id as string | undefined
        if (!invoiceId || !job.org_id) throw new Error("Missing invoice_id or org_id")
        const result = await syncInvoiceToQBO(invoiceId, job.org_id)
        if (result.success) {
          await supabase.from("outbox").update({ status: "completed" }).eq("id", job.id)
          processed++
        } else {
          throw new Error(result.error ?? "Unknown sync error")
        }
      } else if (job.job_type === "qbo_sync_payment") {
        const paymentId = payload.payment_id as string | undefined
        if (!paymentId || !job.org_id) throw new Error("Missing payment_id or org_id")
        const result = await syncPaymentToQBO(paymentId, job.org_id)
        if (result.success) {
          await supabase.from("outbox").update({ status: "completed" }).eq("id", job.id)
          processed++
        } else {
          throw new Error(result.error ?? "Unknown sync error")
        }
      } else {
        await supabase.from("outbox").update({ status: "failed", last_error: "Unknown job type" }).eq("id", job.id)
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
            : job.run_at,
        })
        .eq("id", job.id)

      failed++
    }
  }

  return NextResponse.json({ processed, failed })
}
