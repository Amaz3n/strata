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
  source?: string
}

export async function recordAudit(input: AuditInput) {
  try {
    let resolvedOrgId = input.orgId
    let actorId = input.actorId ?? null
    try {
      const context = await requireOrgContext(input.orgId)
      resolvedOrgId = context.orgId
      actorId = input.actorId ?? context.userId
    } catch (contextError) {
      if (!input.orgId) {
        throw contextError
      }
    }

    if (!resolvedOrgId) {
      throw new Error("Missing org context for audit logging")
    }

    const supabase = createServiceSupabaseClient()

    const { error } = await supabase.from("audit_log").insert({
      org_id: resolvedOrgId,
      actor_user_id: actorId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      before_data: input.before ?? null,
      after_data: input.after ?? null,
      source: input.source,
    })

    if (error) {
      console.error("Failed to record audit log", error)
    }
  } catch (error) {
    console.error("Unable to record audit log", error)
  }
}
