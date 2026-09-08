import type { SupabaseClient } from "@supabase/supabase-js"

export interface DailyLogEmail {
  orgId: string
  userId: string
  title: string
  message: string
  projectId: string
  dailyLogId: string
}

/** Drain only this contribution's durable jobs, after responding to the save.
 * The pending -> processing compare-and-set shares the cron worker's lease
 * protocol. A concurrent cron/retry cannot send a job we already claimed.
 * Crashed callbacks are recovered by reap_stale_outbox_jobs.
 */
export async function deliverDailyLogOutboxEmails(
  db: SupabaseClient,
  orgId: string,
  dailyLogId: string,
  send: (input: DailyLogEmail) => Promise<boolean>,
) {
  const { data: jobs, error } = await db.from("outbox")
    .select("id, payload, retry_count")
    .eq("org_id", orgId)
    .eq("job_type", "send_daily_log_mention_email")
    .eq("status", "pending")
    .lte("run_at", new Date().toISOString())
    .contains("payload", { daily_log_id: dailyLogId })
  if (error) throw new Error("Unable to load queued daily log emails")

  // Bound provider concurrency when @everyone mentions a large project team.
  const remaining = [...(jobs ?? [])]
  await Promise.all(Array.from({ length: Math.min(4, remaining.length) }, async () => {
    while (remaining.length) {
      const job = remaining.shift()!
      const { data: claimed, error: claimError } = await db.from("outbox")
        .update({ status: "processing", updated_at: new Date().toISOString() })
        .eq("id", job.id).eq("org_id", orgId).eq("status", "pending")
        .select("id").maybeSingle()
      if (claimError) throw new Error("Unable to claim daily log email")
      if (!claimed) continue
      try {
        const payload = job.payload as Record<string, string>
        const sent = await send({ orgId, userId: payload.user_id, projectId: payload.project_id,
          dailyLogId, title: payload.title, message: payload.message })
        if (!sent) throw new Error("Email provider did not accept the message")
        const { error: completionError } = await db.from("outbox").update({ status: "completed" })
          .eq("id", job.id).eq("status", "processing")
        if (completionError) throw new Error("Unable to complete daily log email")
      } catch (error) {
        // Remain durable and eligible for the normal retry worker.
        const { error: retryError } = await db.from("outbox").update({
          status: "pending", retry_count: (job.retry_count ?? 0) + 1,
          run_at: new Date(Date.now() + 60_000).toISOString(),
          last_error: error instanceof Error ? error.message : "Daily log email delivery failed",
        }).eq("id", job.id).eq("status", "processing")
        if (retryError) throw new Error("Unable to release daily log email lease")
      }
    }
  }))
}
