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

    const { error } = await supabase.from("outbox").insert({
      org_id: orgId,
      job_type: input.jobType,
      payload,
      event_id: input.eventId,
      run_at: input.runAt,
      dedupe_key: dedupeKey,
    })

    if (error) {
      if (dedupeKey && error.code === "23505") {
        return { enqueued: false as const, reason: "duplicate" as const }
      }
      console.error("Failed to enqueue outbox job", error)
      return { enqueued: false as const, reason: "error" as const }
    }
    return { enqueued: true as const }
  } catch (error) {
    console.error("Unable to enqueue outbox job", error)
    return { enqueued: false as const, reason: "error" as const }
  }
}
