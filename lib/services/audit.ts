import { z } from "zod"

import { logger } from "@/lib/logging/logger"
import { afterResponse } from "@/lib/observability/after-response"
import { correlationId } from "@/lib/observability/correlation"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { enqueueOutboxJob } from "@/lib/services/outbox"
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
  /** See `recordAudit`: the row is evidence the mutation cannot go without. */
  critical?: boolean
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
 * The outbox job that writes a critical audit row its mutation could not.
 * The payload is the complete row, so the job needs nothing but the table.
 */
export const AUDIT_RETRY_JOB_TYPE = "audit_retry"

/**
 * A critical mutation committed but its audit row did not. The message says
 * exactly that: the change is not reported as failed (it saved), and it is not
 * reported as done (its evidence is missing until the retry lands).
 */
export class AuditRecordPendingError extends Error {
  readonly code = "AUDIT_RECORD_PENDING"

  constructor(readonly retryQueued: boolean) {
    super(
      retryQueued
        ? "The change was saved, but its audit record is still pending. It has been reported and will be written automatically."
        : "The change was saved, but its audit record could not be written. It has been reported for follow-up.",
    )
    this.name = "AuditRecordPendingError"
  }
}

const auditRowSchema = z.object({
  org_id: z.string().uuid(),
  actor_user_id: z.string().uuid().nullable(),
  action: z.enum(["insert", "update", "delete"]),
  entity_type: z.string().min(1),
  entity_id: z.string().uuid().nullish(),
  before_data: z.record(z.string(), z.unknown()).nullable(),
  after_data: z.record(z.string(), z.unknown()).nullable(),
  source: z.string().nullish(),
  correlation_id: z.string().nullable(),
  created_at: z.string().datetime({ offset: true }).optional(),
})

type AuditRow = z.infer<typeof auditRowSchema>

async function buildAuditRow(input: AuditInput): Promise<AuditRow> {
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

  return {
    org_id: resolvedOrgId,
    actor_user_id: actorId,
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId,
    before_data: input.before ?? null,
    after_data: input.after ?? null,
    source: input.source,
    correlation_id: await correlationId(),
  }
}

async function insertAuditRow(row: AuditRow): Promise<unknown> {
  try {
    const { error } = await createServiceSupabaseClient().from("audit_log").insert(row)
    return error
  } catch (error) {
    return error
  }
}

/**
 * Append one audit row, stamped with the unit of work's correlation id.
 *
 * Ordinary rows never throw: they run after the mutation they describe has
 * committed, so failing here would report a completed write as failed. A
 * missing row is still a gap in the evidence, so every failure is reported to
 * the error pipeline (log + Sentry) with the entity it was for — never the
 * snapshots, which can hold payroll and banking data.
 *
 * `critical` is for money mutations whose audit row is part of their evidence
 * and is not already written inside the mutation's own transaction. A failed
 * insert is retried once; if it still fails it is reported, the complete row
 * is queued as an `audit_retry` outbox job so it is eventually written, and
 * `AuditRecordPendingError` is thrown so the caller cannot report the change as
 * cleanly done while its evidence is missing.
 */
export async function recordAudit(input: AuditInput) {
  let row: AuditRow
  try {
    row = await buildAuditRow(input)
  } catch (error) {
    reportAuditFailure(input, input.orgId, error)
    // No org means nowhere to queue the row; the report is all there is.
    if (input.critical) throw new AuditRecordPendingError(false)
    return
  }

  let failure = await insertAuditRow(row)
  if (failure && input.critical) failure = await insertAuditRow(row)
  if (failure) reportAuditFailure(input, row.org_id, failure)

  // Keep the unified search index in sync as a side effect of audited
  // mutations. Best-effort and nothing in the response reads it, so it runs
  // after the response rather than inside every write.
  if (input.entityId) {
    const searchType = mapAuditEntityTypeToSearchType(input.entityType)
    if (searchType) {
      const orgId = row.org_id
      const entityId = input.entityId
      const op = input.action === "delete" ? "delete" : "upsert"
      afterResponse("audit.reindex_failed", () =>
        enqueueReindex({ orgId, entityType: searchType, entityId, op }, createServiceSupabaseClient()),
      )
    }
  }

  if (failure && input.critical) {
    const job = await enqueueOutboxJob({
      orgId: row.org_id,
      jobType: AUDIT_RETRY_JOB_TYPE,
      payload: { row: { ...row, created_at: new Date().toISOString() } },
    })
    throw new AuditRecordPendingError(job.enqueued)
  }
}

/**
 * The `audit_retry` worker: write the row a critical mutation queued. Throws on
 * failure so the outbox retries it and, past its attempts, leaves it failed
 * where operations can see it.
 */
export async function writeDeferredAudit(orgId: string, payload: unknown) {
  const { row } = z.object({ row: auditRowSchema }).parse(payload)
  if (row.org_id !== orgId) throw new Error("Deferred audit row belongs to another organization")
  const { error } = await createServiceSupabaseClient().from("audit_log").insert(row)
  if (error) throw new Error(`Deferred audit write failed: ${error.message}`)
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
    critical: input.critical === true,
  })
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message
  return "Audit insert failed"
}
