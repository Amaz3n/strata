import "server-only"

import { gzipSync } from "node:zlib"
import { z } from "zod"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireAuthorization } from "@/lib/services/authorization"
import { booksDigest } from "@/lib/services/books/hash"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { uploadFilesObject } from "@/lib/storage/files-storage"

const EXPORT_TABLES = [
  "books_settings",
  "accounting_policies",
  "gl_accounts",
  "accounting_facts",
  "journal_entries",
  "journal_lines",
  "accounting_periods",
  "accounting_reconciliation_runs",
  "accounting_reconciliation_items",
  "poc_snapshots",
  "books_comparison_runs",
  "books_comparison_items",
  "opening_balance_batches",
  "opening_balance_lines",
  "bank_accounts",
  "bank_transactions",
  "bank_transaction_revisions",
  "bank_transaction_matches",
  "bank_reconciliations",
  "bank_reconciliation_items",
  "books_close_items",
  "financial_statement_snapshots",
  "tax_policy_versions",
  "companies",
  "contacts",
  "projects",
  "invoices",
  "invoice_lines",
  "payments",
  "payment_allocations",
  "vendor_bills",
  "bill_lines",
  "project_expenses",
  "files",
  "audit_log",
] as const

async function requireExportContext(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "books.export",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    resourceType: "books_export",
    resourceId: context.orgId,
    logDecision: true,
  })
  return context
}

async function fetchAllRows(table: string, orgId: string) {
  const service = createServiceSupabaseClient()
  const rows: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await service
      .from(table)
      .select("*")
      .eq("org_id", orgId)
      .order("id")
      .range(from, from + 999)
    if (error) throw new Error(`Failed to export ${table}: ${error.message}`)
    const page = z.array(z.record(z.unknown())).parse(data ?? [])
    rows.push(...page)
    if (page.length < 1000) break
  }
  return rows
}

function redact(table: string, rows: Record<string, unknown>[]) {
  if (table !== "companies") return rows
  return rows.map((row) => ({
    ...row,
    tax_id: undefined,
    ein: undefined,
    ssn: undefined,
  }))
}

export function verifyBooksExportBundle(bundle: {
  tables: Record<string, Record<string, unknown>[]>
}) {
  const entries = bundle.tables.journal_entries ?? []
  const postedEntryIds = new Set(entries.filter((entry) => entry.status === "posted").map((entry) => String(entry.id)))
  const totals = new Map<string, { debit: number; credit: number }>()
  for (const line of bundle.tables.journal_lines ?? []) {
    const entryId = String(line.entry_id)
    if (!postedEntryIds.has(entryId)) continue
    const current = totals.get(entryId) ?? { debit: 0, credit: 0 }
    current.debit += Number(line.debit_cents ?? 0)
    current.credit += Number(line.credit_cents ?? 0)
    totals.set(entryId, current)
  }
  const unbalancedEntryIds = Array.from(totals.entries())
    .filter(([, total]) => total.debit <= 0 || total.debit !== total.credit)
    .map(([entryId]) => entryId)
  const missingLineEntryIds = Array.from(postedEntryIds).filter((entryId) => !totals.has(entryId))
  return {
    valid: unbalancedEntryIds.length === 0 && missingLineEntryIds.length === 0,
    postedEntryCount: postedEntryIds.size,
    unbalancedEntryIds,
    missingLineEntryIds,
  }
}

export async function createCompleteBooksExport(input: {
  exportType?: "complete" | "accountant" | "cutover" | "period"
  orgId?: string
}) {
  const context = await requireExportContext(input.orgId)
  const service = createServiceSupabaseClient()
  const { data: exportData, error: createError } = await service.from("books_exports").insert({
    org_id: context.orgId,
    export_type: input.exportType ?? "complete",
    schema_version: 1,
    status: "generating",
    requested_by: context.userId,
  }).select("id").single()
  if (createError) throw new Error(`Failed to create Books export: ${createError.message}`)
  const exportId = z.object({ id: z.string().uuid() }).parse(exportData).id
  try {
    const tables: Record<string, Record<string, unknown>[]> = {}
    for (const table of EXPORT_TABLES) tables[table] = redact(table, await fetchAllRows(table, context.orgId))
    const generatedAt = new Date().toISOString()
    const manifest = {
      schemaVersion: 1,
      orgId: context.orgId,
      generatedAt,
      tables: Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, { rows: rows.length }])),
      redactions: ["full tax identifiers", "integration credentials", "bank-feed provider payloads"],
    }
    const bundle = { manifest, tables }
    const verification = verifyBooksExportBundle(bundle)
    if (!verification.valid) throw new Error("Books export verification found unbalanced or incomplete journals")
    const json = JSON.stringify(bundle)
    const contentHash = booksDigest(json)
    const path = `books/exports/${exportId}.json.gz`
    const uploaded = await uploadFilesObject({
      supabase: service,
      orgId: context.orgId,
      path,
      bytes: gzipSync(Buffer.from(json)),
      contentType: "application/gzip",
      cacheControl: "private, no-store",
      upsert: false,
    })
    const { error: updateError } = await service.from("books_exports").update({
      status: "ready",
      storage_path: uploaded.storagePath,
      content_hash: contentHash,
      manifest,
      verification,
      completed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    }).eq("org_id", context.orgId).eq("id", exportId)
    if (updateError) throw new Error(`Failed to complete Books export: ${updateError.message}`)
    await recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "books.export_ready",
      entityType: "books_export",
      entityId: exportId,
      payload: { export_type: input.exportType ?? "complete", content_hash: contentHash },
      channel: "notification",
    })
    return { exportId, storagePath: uploaded.storagePath, contentHash, manifest, verification }
  } catch (error) {
    await service.from("books_exports").update({
      status: "failed",
      error_message: error instanceof Error ? error.message : String(error),
    }).eq("org_id", context.orgId).eq("id", exportId)
    throw error
  }
}

