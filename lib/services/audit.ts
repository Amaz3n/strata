import { logger } from "@/lib/logging/logger"
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
 *
 * The table's read policy is `audit.read` (the whole org's history). A record's
 * own trail is authorized here by the record's permission and project instead,
 * and then read with the service role, scoped to that one entity.
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

  const { data, error } = await createServiceSupabaseClient()
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

/**
 * Append one audit row. Never throws: it runs after the mutation it describes
 * has committed, so failing here would report a completed write as failed. A
 * missing row is still a gap in the evidence, so every failure is reported to
 * the error pipeline (log + Sentry) with the entity it was for — never the
 * snapshots, which can hold payroll and banking data.
 */
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
      reportAuditFailure(input, resolvedOrgId, error)
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
    reportAuditFailure(input, input.orgId, error)
  }
}

function reportAuditFailure(input: AuditInput, orgId: string | undefined, error: unknown) {
  logger.error("audit.record_failed", {
    error: error instanceof Error ? error : new Error(errorMessage(error)),
    domain: "audit",
    orgId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    source: input.source,
  })
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return "Audit insert failed"
}
