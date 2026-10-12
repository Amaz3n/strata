import "server-only"

import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_DIGEST_ALGORITHM,
  AUDIT_EXPORT_FORMAT,
  buildAuditExportCsv,
  type AuditExportManifest,
} from "@/lib/audit/export-format"
import { recordAudit } from "@/lib/services/audit"
import { getProjectReadScopeForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { auditExportInputSchema } from "@/lib/validation/audit-export"

/** One keyset page. PostgREST may answer with fewer; the loop reads until empty. */
const PAGE_SIZE = 1_000
/** Past this the file is refused, never cut short: an auditor needs all of it. */
export const AUDIT_EXPORT_MAX_ROWS = 200_000

const SOURCES = {
  changes: { table: "audit_log", time: "created_at" },
  access: { table: "authorization_audit_log", time: "occurred_at" },
} as const

/** A request the export refuses: `forbidden` (who is asking) or `invalid` (what was asked). */
export class AuditExportRefusal extends Error {
  constructor(
    message: string,
    readonly reason: "forbidden" | "invalid",
  ) {
    super(message)
    this.name = "AuditExportRefusal"
  }
}

export interface AuditExportFile {
  csv: string
  filename: string
  digest: string
  manifest: AuditExportManifest
}

type StoredRow = Record<string, unknown>

function storedRow(row: unknown): StoredRow {
  if (typeof row !== "object" || row === null) throw new Error("Audit export read a malformed row.")
  return Object.fromEntries(Object.entries(row))
}

function cursorValue(row: StoredRow, column: string): string {
  const value = row[column]
  if (typeof value === "string" || typeof value === "number") return String(value)
  throw new Error(`Audit export row is missing its ${column}.`)
}

/**
 * The organization's audit evidence for an auditor: every row of one source in
 * [from, to), as a CSV whose manifest and digest let the file be verified
 * without Arc (`verifyAuditExport`).
 *
 * The export is org-wide by nature — before/after snapshots of any record in
 * any division — so it is refused to a member limited to some divisions or
 * projects rather than filtered for them. It is read with the service role,
 * filtered to this organization on every page, and keyset-paged on
 * (time, id) so rows written while it runs cannot shift a page. A range too
 * large to export whole is refused; it is never truncated.
 */
export async function exportOrgAuditEvidence(input: { source: string; from: string; to: string }): Promise<AuditExportFile> {
  const parsed = auditExportInputSchema.safeParse(input)
  if (!parsed.success) throw new AuditExportRefusal(parsed.error.issues[0]?.message ?? "Invalid export range.", "invalid")
  const { source, from } = parsed.data
  // A range that runs past now ends now: rows not written yet cannot be in the
  // file, and the manifest must not claim a period it could not cover.
  const now = new Date().toISOString()
  const to = Date.parse(parsed.data.to) > Date.parse(now) ? now : parsed.data.to

  const context = await requireOrgContext()
  await requireAuthorization({
    permission: "audit.read",
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
    logDecision: true,
    resourceType: "audit_export",
  })
  const scope = await getProjectReadScopeForUser({ orgId: context.orgId, userId: context.userId })
  if (scope.divisionIds !== null || scope.projectMembershipRequired) {
    throw new AuditExportRefusal(
      "Audit exports cover the whole organization. Your access is limited to some divisions or projects, so a member with organization-wide access has to export it.",
      "forbidden",
    )
  }

  const { table, time } = SOURCES[source]
  const columns = AUDIT_EXPORT_COLUMNS[source]
  const service = createServiceSupabaseClient()

  const [countResult, exporterResult] = await Promise.all([
    service
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", context.orgId)
      .gte(time, from)
      .lt(time, to),
    service.from("app_users").select("email").eq("id", context.userId).maybeSingle(),
  ])
  if (countResult.error) throw new Error(`Unable to count audit records: ${countResult.error.message}`)
  if (exporterResult.error) throw new Error(`Unable to load the exporting user: ${exporterResult.error.message}`)
  if ((countResult.count ?? 0) > AUDIT_EXPORT_MAX_ROWS) {
    throw new AuditExportRefusal(
      `This range holds ${countResult.count} records, more than the ${AUDIT_EXPORT_MAX_ROWS.toLocaleString("en-US")} one file can carry. Narrow the range and export it in parts.`,
      "invalid",
    )
  }

  const rows: StoredRow[] = []
  let cursor: { time: string; id: string } | null = null
  for (;;) {
    let query = service
      .from(table)
      .select(columns.join(","))
      .eq("org_id", context.orgId)
      .gte(time, from)
      .lt(time, to)
    if (cursor) query = query.or(`${time}.gt.${cursor.time},and(${time}.eq.${cursor.time},id.gt.${cursor.id})`)
    const { data, error } = await query.order(time, { ascending: true }).order("id", { ascending: true }).limit(PAGE_SIZE)
    if (error) throw new Error(`Unable to read audit records: ${error.message}`)
    const page = (data ?? []).map(storedRow)
    if (page.length === 0) break
    for (const row of page) {
      if (row.org_id !== context.orgId) throw new Error("Audit export read a row from another organization.")
    }
    rows.push(...page)
    if (rows.length > AUDIT_EXPORT_MAX_ROWS) {
      throw new AuditExportRefusal("This range grew past what one file can carry while it was read. Narrow the range.", "invalid")
    }
    const last = page[page.length - 1]
    cursor = { time: cursorValue(last, time), id: cursorValue(last, "id") }
  }

  // Evidence is append-only, so the rows read can only meet or exceed the count
  // taken first; fewer means a page was lost, and the file would be incomplete.
  if (rows.length < (countResult.count ?? 0)) {
    throw new Error(`Audit export read ${rows.length} of ${countResult.count} records in the range; nothing was exported. Try again.`)
  }

  const manifest: AuditExportManifest = {
    format: AUDIT_EXPORT_FORMAT,
    source,
    org_id: context.orgId,
    from,
    to,
    generated_at: new Date().toISOString(),
    exported_by: { user_id: context.userId, email: exporterResult.data?.email ?? null },
    row_count: rows.length,
    columns: [...columns],
    digest_algorithm: AUDIT_EXPORT_DIGEST_ALGORITHM,
  }
  const { csv, digest } = buildAuditExportCsv(manifest, rows)

  await Promise.all([
    recordAudit({
      orgId: context.orgId,
      action: "insert",
      entityType: "audit_export",
      after: { ...manifest, digest },
      source: "audit_export",
      // A file of evidence is never handed out without its own record.
      critical: true,
    }),
    recordEvent({
      orgId: context.orgId,
      eventType: "audit_exported",
      entityType: "audit_export",
      payload: { source, from, to, row_count: rows.length, digest },
    }),
  ])

  const day = (value: string) => value.slice(0, 10)
  return {
    csv,
    digest,
    manifest,
    filename: `arc-audit-${source}-${day(from)}-to-${day(to)}.csv`,
  }
}
