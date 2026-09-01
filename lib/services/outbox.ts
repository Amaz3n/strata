import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"

interface OutboxJobInput {
  orgId?: string
  jobType: string
  payload?: Record<string, unknown>
  eventId?: string
  runAt?: string
  dedupeByPayloadKeys?: string[]
}

function buildDedupeKey(jobType: string, payload: Record<string, unknown>, keys?: string[]) {
  const parts = (keys ?? [])
    .map((key) => {
      const value = payload[key]
      if (value === undefined || value === null) return null
      return `${key}:${String(value)}`
    })
    .filter((part): part is string => part !== null)

  if (parts.length === 0) return null
  return `${jobType}:${parts.join("|")}`
}

export async function enqueueOutboxJob(input: OutboxJobInput) {
  try {
    const supabase = createServiceSupabaseClient()
    let orgId = input.orgId
    if (!orgId) {
      const context = await requireOrgContext()
      orgId = context.orgId
    }
    if (!orgId) {
      return { enqueued: false as const, reason: "error" as const }
    }
    const payload = input.payload ?? {}
    const dedupeKey = buildDedupeKey(input.jobType, payload, input.dedupeByPayloadKeys)

    const { data, error } = await supabase
      .from("outbox")
      .insert({
        org_id: orgId,
        job_type: input.jobType,
        payload,
        event_id: input.eventId,
        run_at: input.runAt,
        dedupe_key: dedupeKey,
      })
      .select("id")
      .single()

    if (error) {
      if (dedupeKey && error.code === "23505") {
        return { enqueued: false as const, reason: "duplicate" as const }
      }
      console.error("Failed to enqueue outbox job", error)
      return { enqueued: false as const, reason: "error" as const }
    }
    return { enqueued: true as const, id: data?.id as number | string | undefined }
  } catch (error) {
    console.error("Unable to enqueue outbox job", error)
    return { enqueued: false as const, reason: "error" as const }
  }
}

/**
 * Close a job whose work the request already finished.
 *
 * The durable pattern is: enqueue first so a crash is recoverable, do the work
 * inline so the user sees the result now, then complete the row so the cron does
 * not repeat it. Failing to complete is not an error — the worker will simply run
 * an idempotent job a second time.
 */
export async function completeOutboxJob(id: number | string | undefined | null) {
  if (id === undefined || id === null) return
  try {
    const supabase = createServiceSupabaseClient()
    await supabase.from("outbox").update({ status: "completed" }).eq("id", id).eq("status", "pending")
  } catch (error) {
    console.error("Unable to complete outbox job", id, error)
  }
}
