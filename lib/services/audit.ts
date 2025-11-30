import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"

interface AuditInput {
  orgId?: string
  actorId?: string
  action: "insert" | "update" | "delete"
  entityType: string
  entityId?: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  reason?: string
}

export async function recordAudit(input: AuditInput) {
  try {
    const context = await requireOrgContext(input.orgId)
    const supabase = createServiceSupabaseClient()

    const { error } = await supabase.from("audit_log").insert({
      org_id: context.orgId,
      actor_id: input.actorId ?? context.userId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      before: input.before ?? null,
      after: input.after ?? null,
      reason: input.reason,
    })

    if (error) {
      console.error("Failed to record audit log", error)
    }
  } catch (error) {
    console.error("Unable to record audit log", error)
  }
}
