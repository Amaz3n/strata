import { afterResponse } from "@/lib/observability/after-response"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
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

export interface EntityAuditEntry {
  id: number
  action: "insert" | "update" | "delete"
  source: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  createdAt: string
  actor: { id: string; name: string; email: string } | null
}

/**
 * Permission-checked document history for operational record pages.
 *
 * The audit table is intentionally append-only evidence. This reader returns
 * the snapshots as stored rather than attempting to recreate mutable rows.
 */
export async function listEntityAuditTrail(input: {
  entityType: string
  entityId: string
  permission: string
  orgId?: string
  projectId?: string | null
  limit?: number
}): Promise<EntityAuditEntry[]> {
  const context = await requireOrgContext(input.orgId)
  await requireAuthorization({
    permission: input.permission,
    userId: context.userId,
    orgId: context.orgId,
    projectId: input.projectId ?? undefined,
    supabase: context.supabase,
    logDecision: true,
    resourceType: input.entityType,
    resourceId: input.entityId,
  })

  const { data, error } = await context.supabase
    .from("audit_log")
    .select(`
      id,
      action,
      source,
      before_data,
      after_data,
      created_at,
      actor_user:actor_user_id (
        id,
        full_name,
        email
      )
    `)
    .eq("org_id", context.orgId)
    .eq("entity_type", input.entityType)
    .eq("entity_id", input.entityId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 100))

  if (error) throw new Error(`Failed to load change history: ${error.message}`)

  return (data ?? []).map((row) => {
    const rawActor = Array.isArray(row.actor_user) ? row.actor_user[0] : row.actor_user
    return {
      id: Number(row.id),
      action: row.action as EntityAuditEntry["action"],
      source: row.source ?? null,
      before: (row.before_data as Record<string, unknown> | null) ?? null,
      after: (row.after_data as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at,
      actor: rawActor
        ? {
            id: rawActor.id,
            name: rawActor.full_name || rawActor.email,
            email: rawActor.email,
          }
        : null,
    }
  })
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
    // mutations. Best-effort and nothing in the response reads it, so it runs
    // after the response rather than inside every write.
    if (input.entityId) {
      const searchType = mapAuditEntityTypeToSearchType(input.entityType)
      if (searchType) {
        const orgId = resolvedOrgId
        const entityId = input.entityId
        const op = input.action === "delete" ? "delete" : "upsert"
        afterResponse("audit.reindex_failed", () =>
          enqueueReindex({ orgId, entityType: searchType, entityId, op }, supabase),
        )
      }
    }
  } catch (error) {
    console.error("Unable to record audit log", error)
  }
}
