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

    if ((input.dedupeByPayloadKeys ?? []).length > 0) {
      let query = supabase
        .from("outbox")
        .select("id")
        .eq("org_id", orgId)
        .eq("job_type", input.jobType)
        .in("status", ["pending", "processing"])
      let matchedKeys = 0

      for (const key of input.dedupeByPayloadKeys ?? []) {
        const value = payload[key]
        if (value === undefined || value === null) continue
        matchedKeys += 1
        query = query.contains("payload", { [key]: value })
      }

      if (matchedKeys > 0) {
        const { data: existing } = await query.limit(1).maybeSingle()
        if (existing?.id) {
          return { enqueued: false as const, reason: "duplicate" as const }
        }
      }
    }

    const { error } = await supabase.from("outbox").insert({
      org_id: orgId,
      job_type: input.jobType,
      payload,
      event_id: input.eventId,
      run_at: input.runAt,
    })

    if (error) {
      console.error("Failed to enqueue outbox job", error)
      return { enqueued: false as const, reason: "error" as const }
    }
    return { enqueued: true as const }
  } catch (error) {
    console.error("Unable to enqueue outbox job", error)
    return { enqueued: false as const, reason: "error" as const }
  }
}
