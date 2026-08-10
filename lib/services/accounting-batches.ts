import "server-only"

import { z } from "zod"

import {
  BATCH_FORMATS,
  renderAccountingBatch,
  type AccountingBatchFormat,
  type BatchLineRecord,
} from "@/lib/integrations/accounting/file/formats"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** A batch is a file a human hands to an ERP, so it has to fit in one. */
const MAX_BATCH_LINES = 20_000

export interface AccountingBatchSummary {
  id: string
  connectionId: string
  connectionLabel: string
  format: AccountingBatchFormat
  formatLabel: string
  status: "open" | "exported" | "void"
  lineCount: number
  totalCents: number
  exportedAt: string | null
  createdAt: string
}

interface BatchRow {
  id: string
  connection_id: string
  format: AccountingBatchFormat
  status: "open" | "exported" | "void"
  line_count: number
  total_cents: number
  exported_at: string | null
  created_at: string
}

export async function listAccountingBatches(orgId?: string): Promise<AccountingBatchSummary[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("financials.export", context)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("accounting_batches")
    .select("id,connection_id,format,status,line_count,total_cents,exported_at,created_at")
    .eq("org_id", context.orgId)
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new Error(`Unable to list accounting batches: ${error.message}`)
  const rows = (data ?? []) as BatchRow[]
  const connectionIds = [...new Set(rows.map((row) => row.connection_id))]
  const { data: connections } = connectionIds.length > 0
    ? await supabase.from("accounting_connections").select("id,label").eq("org_id", context.orgId).in("id", connectionIds)
    : { data: [] }
  const labelById = new Map((connections ?? []).map((connection) => [connection.id, connection.label]))
  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    connectionLabel: labelById.get(row.connection_id) ?? "Accounting connection",
    format: row.format,
    formatLabel: BATCH_FORMATS[row.format].label,
    status: row.status,
    lineCount: Number(row.line_count),
    totalCents: Number(row.total_cents),
    exportedAt: row.exported_at,
    createdAt: row.created_at,
  }))
}

/**
 * Render a batch and close it.
 *
 * Closing is the point: an exported batch is a file someone imported into their
 * ledger, so it must never gain another line afterwards. Marking it exported in
 * the same call that produces the bytes is what guarantees that — and re-reading
 * an already-exported batch reproduces the identical file rather than a moving
 * target, because the format is stored on the batch rather than read from the
 * connection at render time.
 */
export async function exportAccountingBatch(input: { batchId: string }, orgId?: string): Promise<{
  fileName: string
  contentType: string
  content: string
  lineCount: number
}> {
  const parsed = z.object({ batchId: z.string().uuid() }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("financials.export", context)
  const supabase = createServiceSupabaseClient()

  const { data: batch, error } = await supabase
    .from("accounting_batches")
    .select("id,format,status,line_count")
    .eq("org_id", context.orgId)
    .eq("id", parsed.batchId)
    .maybeSingle()
  if (error || !batch) throw new Error("Accounting batch was not found")
  if (batch.status === "void") throw new Error("This accounting batch was voided")
  if (Number(batch.line_count) > MAX_BATCH_LINES) {
    throw new Error(`This batch has ${batch.line_count} lines, beyond the ${MAX_BATCH_LINES}-line import limit. Split it before exporting.`)
  }

  const { data: lines, error: linesError } = await supabase
    .from("accounting_batch_lines")
    .select("entity_type,direction,amount_cents,currency,posted_at,memo,payload")
    .eq("org_id", context.orgId)
    .eq("batch_id", parsed.batchId)
    .order("posted_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_BATCH_LINES)
  if (linesError) throw new Error(`Unable to load accounting batch lines: ${linesError.message}`)

  const records: BatchLineRecord[] = (lines ?? []).map((line) => ({
    entityType: line.entity_type,
    direction: line.direction,
    amountCents: Number(line.amount_cents),
    currency: String(line.currency ?? "usd"),
    postedAt: line.posted_at,
    memo: line.memo,
    payload: (line.payload as Record<string, unknown> | null) ?? {},
  }))
  const format = batch.format as AccountingBatchFormat
  const content = renderAccountingBatch(format, records)

  // Only the first export closes the batch. Re-downloading is not a new export
  // and must not restamp who exported it or when.
  if (batch.status === "open") {
    const { error: closeError } = await supabase
      .from("accounting_batches")
      .update({ status: "exported", exported_at: new Date().toISOString(), exported_by: context.userId })
      .eq("org_id", context.orgId)
      .eq("id", parsed.batchId)
      .eq("status", "open")
    if (closeError) throw new Error(`Unable to close accounting batch: ${closeError.message}`)
    await Promise.all([
      recordEvent({
        orgId: context.orgId,
        actorId: context.userId,
        eventType: "accounting_batch_exported",
        entityType: "accounting_batch",
        entityId: parsed.batchId,
        payload: { format, line_count: records.length },
      }),
      recordAudit({
        orgId: context.orgId,
        actorId: context.userId,
        action: "update",
        entityType: "accounting_batch",
        entityId: parsed.batchId,
        before: { status: "open" },
        after: { status: "exported", line_count: records.length },
      }),
    ])
  }

  return {
    fileName: `arc-${format}-batch-${parsed.batchId.slice(0, 8)}.${BATCH_FORMATS[format].fileExtension}`,
    contentType: "text/csv;charset=utf-8",
    content,
    lineCount: records.length,
  }
}
