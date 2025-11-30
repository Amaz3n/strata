import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"

interface OutboxJobInput {
  orgId?: string
  jobType: string
  payload?: Record<string, unknown>
  eventId?: string
  runAt?: string
}

export async function enqueueOutboxJob(input: OutboxJobInput) {
  try {
    const { orgId } = await requireOrgContext(input.orgId)
    const supabase = createServiceSupabaseClient()

    const { error } = await supabase.from("outbox").insert({
      org_id: orgId,
      job_type: input.jobType,
      payload: input.payload ?? {},
      event_id: input.eventId,
      run_at: input.runAt,
    })

    if (error) {
      console.error("Failed to enqueue outbox job", error)
    }
  } catch (error) {
    console.error("Unable to enqueue outbox job", error)
  }
}
