import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

type RecordESignEventInput = {
  orgId: string
  eventType: string
  envelopeId: string
  documentId?: string
  payload?: Record<string, unknown>
  actorId?: string
  supabase?: SupabaseClient<any, "public", any>
}

export async function recordESignEvent(input: RecordESignEventInput) {
  const client = input.supabase ?? createServiceSupabaseClient()
  const payload: Record<string, unknown> = {
    ...(input.payload ?? {}),
    ...(input.actorId ? { actor_id: input.actorId } : {}),
    envelope_id: input.envelopeId,
    ...(input.documentId ? { document_id: input.documentId } : {}),
  }

  const { error } = await client.from("events").insert({
    org_id: input.orgId,
    event_type: input.eventType,
    entity_type: "envelope",
    entity_id: input.envelopeId,
    payload,
    channel: "activity",
  })

  if (error) {
    console.error("Failed to record e-sign event", {
      orgId: input.orgId,
      eventType: input.eventType,
      envelopeId: input.envelopeId,
      error: error.message,
    })
  }
}
