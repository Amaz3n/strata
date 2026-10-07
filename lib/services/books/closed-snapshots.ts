import "server-only"

import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * The reports saved when a period closed, for a closed period matched by its end
 * (and start, when given). Statements and aging for that exact period read these
 * rather than a live rebuild, so later work cannot change how a closed month reads.
 */
export async function loadClosedPeriodSnapshots(orgId: string, period: { start?: string; end: string }) {
  const service = createServiceSupabaseClient()
  let query = service.from("accounting_periods").select("id, closed_at, close_snapshot_ids")
    .eq("org_id", orgId).eq("status", "closed").eq("period_end", period.end)
  if (period.start) query = query.eq("period_start", period.start)
  const { data: found, error } = await query.maybeSingle()
  if (error) throw new Error(`Failed to load the closed period: ${error.message}`)
  const ids = z.array(z.string().uuid()).safeParse(found?.close_snapshot_ids)
  if (!found || !ids.success || ids.data.length === 0) return null
  const { data: snapshots, error: snapshotError } = await service.from("financial_statement_snapshots").select("statement_type, content")
    .eq("org_id", orgId).eq("period_id", found.id).in("id", ids.data)
  if (snapshotError) throw new Error(`Failed to load the closed period's reports: ${snapshotError.message}`)
  return {
    periodId: String(found.id),
    closedAt: String(found.closed_at),
    /** The saved report of this type, checked to be one. */
    report<T>(type: string) {
      const content = snapshots?.find((row) => row.statement_type === type)?.content
      return z.custom<T>((value) => typeof value === "object" && value !== null && Reflect.get(value, "statement") === type).parse(content)
    },
  }
}
