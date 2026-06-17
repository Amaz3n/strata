import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { enqueueReindex, mapAuditEntityTypeToSearchType } from "@/lib/services/search-index"

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

    // Keep the unified search index in sync as a side effect of audited
    // mutations. Best-effort: a failure here must never break the audit path.
    if (input.entityId) {
      const searchType = mapAuditEntityTypeToSearchType(input.entityType)
      if (searchType) {
        try {
          await enqueueReindex(
            {
              orgId: resolvedOrgId,
              entityType: searchType,
              entityId: input.entityId,
              op: input.action === "delete" ? "delete" : "upsert",
            },
            supabase,
          )
        } catch (reindexError) {
          console.error("Unable to enqueue search reindex", reindexError)
        }
      }
    }
  } catch (error) {
    console.error("Unable to record audit log", error)
  }
}
