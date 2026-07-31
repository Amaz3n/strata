import "server-only"

import type { ReportContext, ReportFormat, ReportResult } from "@/lib/reports/types"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"

/**
 * Immutable history of every report pulled out of Arc.
 *
 * The snapshot is the point: a WIP schedule sent to a lender in July has to be
 * reproducible in October, after the invoices behind it have moved. Runs are
 * append-only — nothing here updates or deletes.
 */

export interface ReportRunDTO {
  id: string
  slug: string
  scope: "org" | "project"
  projectId: string | null
  params: Record<string, string>
  rowCount: number
  format: ReportFormat | "view"
  title: string
  subtitle: string | null
  runByName: string | null
  createdAt: string
}

export interface ReportRunDetail extends ReportRunDTO {
  snapshot: ReportResult
}

const RUN_SELECT =
  "id, slug, scope, project_id, params, row_count, format, title, subtitle, created_at, run_by:app_users(full_name)"

function countRows(result: ReportResult) {
  return result.tables.reduce((total, table) => total + table.rows.length, 0)
}

function mapRun(row: any): ReportRunDTO {
  const runBy = Array.isArray(row.run_by) ? row.run_by[0] : row.run_by
  return {
    id: row.id,
    slug: row.slug,
    scope: row.scope,
    projectId: row.project_id,
    params: (row.params ?? {}) as Record<string, string>,
    rowCount: row.row_count ?? 0,
    format: row.format,
    title: row.title,
    subtitle: row.subtitle,
    runByName: runBy?.full_name ?? null,
    createdAt: row.created_at,
  }
}

/**
 * Records one pull. Exports always snapshot; on-screen views do not, or every
 * parameter tweak would write a row and the history would be unreadable.
 */
export async function recordReportRun(input: {
  slug: string
  context: ReportContext
  title: string
  result: ReportResult
  format: ReportFormat | "view"
  orgId?: string
}): Promise<string | null> {
  const { supabase, orgId, userId } = await requireOrgContext(input.orgId)
  await requirePermission("report.read", { supabase, orgId, userId })

  const { data, error } = await supabase
    .from("report_runs")
    .insert({
      org_id: orgId,
      slug: input.slug,
      scope: input.context.scope,
      project_id: input.context.projectId ?? null,
      division_id: input.context.divisionId ?? null,
      community_id: input.context.communityId ?? null,
      params: input.context.params,
      snapshot: input.result,
      row_count: countRows(input.result),
      format: input.format,
      title: input.title,
      subtitle: input.result.subtitle ?? null,
      run_by: userId,
    })
    .select("id")
    .single()

  if (error) throw new Error(`Failed to record report run: ${error.message}`)

  await recordEvent({
    orgId,
    eventType: "report_exported",
    entityType: "report_run",
    entityId: data.id,
    payload: {
      slug: input.slug,
      format: input.format,
      scope: input.context.scope,
      project_id: input.context.projectId ?? null,
      row_count: countRows(input.result),
    },
    channel: "activity",
  })

  return data.id
}

export async function listReportRuns(
  opts: { slug?: string; projectId?: string; limit?: number } = {},
  orgId?: string,
): Promise<ReportRunDTO[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("report.read", { supabase, orgId: resolvedOrgId, userId })

  let query = supabase
    .from("report_runs")
    .select(RUN_SELECT)
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })
    .limit(Math.min(opts.limit ?? 25, 100))

  if (opts.slug) query = query.eq("slug", opts.slug)
  if (opts.projectId) query = query.eq("project_id", opts.projectId)

  const { data, error } = await query
  if (error) throw new Error(`Failed to load report runs: ${error.message}`)
  return (data ?? []).map(mapRun)
}

export async function getReportRun(id: string, orgId?: string): Promise<ReportRunDetail | null> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("report.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("report_runs")
    .select(`${RUN_SELECT}, snapshot`)
    .eq("org_id", resolvedOrgId)
    .eq("id", id)
    .maybeSingle()

  if (error) throw new Error(`Failed to load report run: ${error.message}`)
  if (!data) return null
  return { ...mapRun(data), snapshot: data.snapshot as ReportResult }
}
