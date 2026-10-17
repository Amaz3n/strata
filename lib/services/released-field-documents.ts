import "server-only"

import {
  compareReleasedSheets,
  drawingReleaseState,
  type DrawingReleaseState,
} from "@/lib/field/released-drawings"
import { requireOrgContext } from "@/lib/services/context"
import { hasProjectPermission, requireProjectPermission } from "@/lib/services/permissions"
import { buildDrawingsImageUrl } from "@/lib/storage/drawings-urls"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Sheet-revision rows read for one home; reaching it is shown to the reader, never dropped quietly. */
export const RELEASED_VERSION_CAP = 1_000
const COMMITMENT_CAP = 100
const LINE_CAP = 1_000
const OPTION_CAP = 500
/** Confirmed by the buyer — what the house is built with. Earlier states are still choices. */
const RELEASED_OPTION_STATUSES = ["confirmed", "ordered", "received"]
/** A drafted or cancelled commitment is not a scope anyone has been awarded. */
const RELEASED_COMMITMENT_STATUSES = ["approved", "complete"]

export interface ReleasedSheetDTO {
  sheetId: string
  sheetNumber: string
  sheetTitle: string | null
  discipline: string | null
  revisionId: string
  revisionLabel: string
  issuedAt: string
  state: DrawingReleaseState
  thumbnailUrl: string | null
}

export interface ReleasedOptionDTO {
  id: string
  categoryName: string
  optionName: string
  status: string
}

export interface ReleasedScopeDTO {
  commitmentId: string
  title: string
  companyName: string | null
  status: string
  lines: Array<{ id: string; description: string; quantity: number | null; unit: string | null }>
}

export interface ReleasedForHomeDTO {
  sheets: ReleasedSheetDTO[]
  /** Null when the viewer's role cannot read selections; the page says so instead of listing. */
  options: ReleasedOptionDTO[] | null
  /** Null when the viewer's role cannot read commitments. */
  scope: ReleasedScopeDTO[] | null
  /** True when a cap cut the lists; the page says so rather than implying completeness. */
  truncated: boolean
}

export interface ReleasedForTradeDTO {
  sheets: ReleasedSheetDTO[]
  options: ReleasedOptionDTO[]
  scope: ReleasedScopeDTO[]
  truncated: boolean
}

type One<T> = T | T[] | null

type VersionRow = {
  id: string
  drawing_revision_id: string
  thumb_path: string | null
  sheet: One<{
    id: string
    sheet_number: string
    sheet_title: string | null
    discipline: string | null
    current_revision_id: string | null
    share_with_subs: boolean
  }>
  revision: One<{
    id: string
    revision_label: string | null
    status: string
    issued_date: string | null
    created_at: string
    cancelled_at: string | null
  }>
}

function one<T>(value: One<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

const VERSION_SELECT = `id, drawing_revision_id, thumb_path,
  sheet:drawing_sheets!inner(id, project_id, sheet_number, sheet_title, discipline, current_revision_id, share_with_subs),
  revision:drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey!inner(id, revision_label, status, issued_date, created_at, cancelled_at)`

async function loadSheets(
  orgId: string,
  projectId: string,
  scope: "field" | "trade",
): Promise<{ sheets: ReleasedSheetDTO[]; truncated: boolean }> {
  let query = createServiceSupabaseClient()
    .from("drawing_sheet_versions")
    .select(VERSION_SELECT)
    .eq("org_id", orgId)
    .eq("sheet.project_id", projectId)
    .is("revision.cancelled_at", null)
  // A trade is shown only what the builder released to trades, and only
  // published revisions of it: a copy still in review is nobody's to build from.
  if (scope === "trade") query = query.eq("sheet.share_with_subs", true).eq("revision.status", "published")
  const { data, error } = await query.order("id").limit(RELEASED_VERSION_CAP + 1).returns<VersionRow[]>()
  if (error) throw new Error(`Failed to load released drawings: ${error.message}`)
  const rows = data ?? []
  const sheets = rows.slice(0, RELEASED_VERSION_CAP).flatMap((row): ReleasedSheetDTO[] => {
    const sheet = one(row.sheet)
    const revision = one(row.revision)
    if (!sheet || !revision) return []
    return [{
      sheetId: sheet.id,
      sheetNumber: sheet.sheet_number,
      sheetTitle: sheet.sheet_title,
      discipline: sheet.discipline,
      revisionId: revision.id,
      revisionLabel: revision.revision_label ?? "Unlabelled",
      issuedAt: revision.issued_date ?? revision.created_at,
      state: drawingReleaseState({
        revisionId: revision.id,
        revisionStatus: revision.status,
        sheetCurrentRevisionId: sheet.current_revision_id,
      }),
      thumbnailUrl: buildDrawingsImageUrl(row.thumb_path),
    }]
  }).sort(compareReleasedSheets)
  return { sheets, truncated: rows.length > RELEASED_VERSION_CAP }
}

type CommitmentRow = {
  id: string
  title: string
  status: string
  company: One<{ name: string }>
  lines: Array<{ id: string; description: string; quantity: number | string | null; unit: string | null; sort_order: number | null }> | null
}

async function loadScope(
  orgId: string,
  projectId: string,
  companyId: string | null,
): Promise<{ scope: ReleasedScopeDTO[]; truncated: boolean }> {
  let query = createServiceSupabaseClient()
    .from("commitments")
    .select("id, title, status, company:companies(name), lines:commitment_lines(id, description, quantity, unit, sort_order)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", RELEASED_COMMITMENT_STATUSES)
  if (companyId) query = query.eq("company_id", companyId)
  const { data, error } = await query.order("created_at").order("id").limit(COMMITMENT_CAP + 1).returns<CommitmentRow[]>()
  if (error) throw new Error(`Failed to load released scope: ${error.message}`)
  const rows = data ?? []
  let lineCount = 0
  let linesCut = false
  const scope = rows.slice(0, COMMITMENT_CAP).map((row): ReleasedScopeDTO => {
    const lines = [...(row.lines ?? [])].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id))
    const room = Math.max(0, LINE_CAP - lineCount)
    if (lines.length > room) linesCut = true
    const kept = lines.slice(0, room)
    lineCount += kept.length
    return {
      commitmentId: row.id,
      title: row.title,
      companyName: one(row.company)?.name ?? null,
      status: row.status,
      lines: kept.map((line) => ({
        id: line.id,
        description: line.description,
        quantity: line.quantity === null ? null : Number(line.quantity),
        unit: line.unit,
      })),
    }
  })
  return { scope, truncated: rows.length > COMMITMENT_CAP || linesCut }
}

type SelectionRow = {
  id: string
  status: string
  category: One<{ name: string }>
  option: One<{ name: string }>
}

async function loadOptions(orgId: string, projectId: string): Promise<{ options: ReleasedOptionDTO[]; truncated: boolean }> {
  const { data, error } = await createServiceSupabaseClient()
    .from("project_selections")
    .select("id, status, category:selection_categories(name), option:selection_options!project_selections_selected_option_id_fkey(name)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("status", RELEASED_OPTION_STATUSES)
    .not("selected_option_id", "is", null)
    .order("id")
    .limit(OPTION_CAP + 1)
    .returns<SelectionRow[]>()
  if (error) throw new Error(`Failed to load released options: ${error.message}`)
  const rows = data ?? []
  const options = rows.slice(0, OPTION_CAP).flatMap((row): ReleasedOptionDTO[] => {
    const option = one(row.option)
    return option ? [{ id: row.id, status: row.status, categoryName: one(row.category)?.name ?? "Option", optionName: option.name }] : []
  }).sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.optionName.localeCompare(b.optionName))
  return { options, truncated: rows.length > OPTION_CAP }
}

/**
 * The superintendent's view of what this home is built from: its drawings with
 * their revision state, the options the buyer confirmed, and every awarded
 * scope. Authorized as the viewer on this project (division scope included);
 * prices are never read.
 */
export async function getReleasedForHome(projectId: string, orgId?: string): Promise<ReleasedForHomeDTO> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "drawing.read")
  const { data: project, error } = await context.supabase.from("projects").select("id")
    .eq("org_id", context.orgId).eq("id", projectId).maybeSingle()
  if (error) throw new Error(`Failed to load home: ${error.message}`)
  if (!project) throw new Error("Home not found")
  const [canScope, canOptions] = await Promise.all([
    hasProjectPermission(context.userId, projectId, "commitment.scope.read"),
    hasProjectPermission(context.userId, projectId, "selections.released.read"),
  ])
  const [sheets, options, scope] = await Promise.all([
    loadSheets(context.orgId, projectId, "field"),
    canOptions ? loadOptions(context.orgId, projectId) : null,
    canScope ? loadScope(context.orgId, projectId, null) : null,
  ])
  return {
    sheets: sheets.sheets,
    options: options?.options ?? null,
    scope: scope?.scope ?? null,
    truncated: sheets.truncated || Boolean(options?.truncated) || Boolean(scope?.truncated),
  }
}

/**
 * The trade's view, called only after the portal gate resolved this company on
 * this project: released drawings shared with trades, the home's confirmed
 * options (names only, never prices), and the scope lines of this company's own
 * commitments. Nothing else is read.
 */
export async function getReleasedForTrade(input: { orgId: string; projectId: string; companyId: string }): Promise<ReleasedForTradeDTO> {
  const [sheets, options, scope] = await Promise.all([
    loadSheets(input.orgId, input.projectId, "trade"),
    loadOptions(input.orgId, input.projectId),
    loadScope(input.orgId, input.projectId, input.companyId),
  ])
  return { sheets: sheets.sheets, options: options.options, scope: scope.scope, truncated: sheets.truncated || options.truncated || scope.truncated }
}
