import { logAccounting } from "@/lib/services/accounting-logger"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type AccountingSyncAttemptOutcome = "synced" | "skipped" | "deferred" | "error" | "needs_review" | "conflict"

/**
 * Append one row to the per-attempt sync trace.
 *
 * Best-effort by design: the trace explains sync, it must never fail it. That
 * also covers the deploy window before the `accounting_sync_attempts`
 * migration is applied — a missing table degrades to a single warn log per
 * call, not a broken push.
 */
export async function recordAccountingSyncAttempt(input: {
  orgId: string
  connectionId?: string | null
  provider: string
  entityType: string
  /** Null when an inbound remote record has no Arc counterpart yet. */
  entityId: string | null
  externalId?: string | null
  direction: "outbound" | "inbound"
  outcome: AccountingSyncAttemptOutcome
  message?: string | null
}): Promise<void> {
  try {
    const supabase = createServiceSupabaseClient()
    const { error } = await supabase.from("accounting_sync_attempts").insert({
      org_id: input.orgId,
      connection_id: input.connectionId ?? null,
      provider: input.provider,
      entity_type: input.entityType,
      entity_id: input.entityId ?? null,
      external_id: input.externalId ?? null,
      direction: input.direction,
      outcome: input.outcome,
      message: input.message?.slice(0, 4000) ?? null,
    })
    if (error) throw new Error(error.message)
  } catch (error) {
    logAccounting("warn", "sync_attempt_trace_failed", {
      orgId: input.orgId,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
