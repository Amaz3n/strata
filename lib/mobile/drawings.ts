import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type {
  MobileDrawingPinDTO,
  MobileDrawingSetDTO,
  MobileDrawingSheetDTO,
  MobileDrawingSheetDetailDTO,
  MobileDrawingSheetVersionDTO,
} from "@/lib/mobile/contracts"
import { listProjects } from "@/lib/services/projects"
import { buildDrawingsImageUrl } from "@/lib/storage/drawings-urls"
import { DISCIPLINE_LABELS } from "@/lib/validation/drawings"

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

function disciplineLabel(discipline: string | null): string | null {
  if (!discipline) return null
  return (DISCIPLINE_LABELS as Record<string, string>)[discipline] ?? null
}

// Resolve the best renderable URL for a version row. The rendered images live in
// a public bucket addressed by path; fall back to any legacy signed URL columns.
function imageUrlFromVersion(
  row: any,
  size: "thumb" | "medium" | "full",
): string | null {
  const pathKey = `${size}_path`
  const legacyKey = size === "thumb" ? "thumbnail_url" : `${size}_url`
  return buildDrawingsImageUrl(row?.[pathKey]) ?? row?.[legacyKey] ?? null
}

// ============================================================================
// DRAWING SETS
// ============================================================================

export async function listMobileDrawingSets(
  context: MobileOrgContext,
  projectId: string,
): Promise<MobileDrawingSetDTO[]> {
  await requireProject(context, projectId)

  const { data, error } = await context.serviceSupabase
    .from("drawing_sets")
    .select("id, project_id, title, description, status, total_pages, processed_pages, updated_at, drawing_sheets(count)")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) throw new MobileAPIError(500, "drawing_sets_unavailable", "Drawing sets could not be loaded.")

  return (data ?? []).map((row: any) => ({
    id: row.id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? null,
    status: row.status,
    total_pages: row.total_pages ?? null,
    processed_pages: row.processed_pages ?? 0,
    sheet_count: row.drawing_sheets?.[0]?.count ?? 0,
    updated_at: row.updated_at,
  }))
}

// ============================================================================
// DRAWING SHEETS
// ============================================================================

interface VersionImageInfo {
  thumbnail_url: string | null
  image_url: string | null
  image_width: number | null
  image_height: number | null
}

async function loadCurrentVersionImages(
  context: MobileOrgContext,
  sheetRows: Array<{ id: string; current_revision_id: string | null }>,
): Promise<{ images: Map<string, VersionImageInfo>; versionCounts: Map<string, number> }> {
  const sheetIds = sheetRows.map((row) => row.id)
  const images = new Map<string, VersionImageInfo>()
  const versionCounts = new Map<string, number>()
  if (!sheetIds.length) return { images, versionCounts }

  const { data, error } = await context.serviceSupabase
    .from("drawing_sheet_versions")
    .select(
      "drawing_sheet_id, drawing_revision_id, thumb_path, medium_path, full_path, thumbnail_url, medium_url, full_url, image_width, image_height, created_at",
    )
    .eq("org_id", context.orgId)
    .in("drawing_sheet_id", sheetIds)
    .order("created_at", { ascending: false })

  if (error) throw new MobileAPIError(500, "drawing_sheets_unavailable", "Drawing sheet images could not be loaded.")

  const currentRevisionBySheet = new Map(sheetRows.map((row) => [row.id, row.current_revision_id]))

  for (const row of data ?? []) {
    versionCounts.set(row.drawing_sheet_id, (versionCounts.get(row.drawing_sheet_id) ?? 0) + 1)
    if (images.has(row.drawing_sheet_id)) continue
    const wantsRevision = currentRevisionBySheet.get(row.drawing_sheet_id)
    // Prefer the version tied to the sheet's current revision; the rows are
    // ordered newest-first so the first match wins.
    if (wantsRevision && row.drawing_revision_id !== wantsRevision) continue
    images.set(row.drawing_sheet_id, {
      thumbnail_url: imageUrlFromVersion(row, "thumb") ?? imageUrlFromVersion(row, "medium"),
      image_url:
        imageUrlFromVersion(row, "full") ?? imageUrlFromVersion(row, "medium") ?? imageUrlFromVersion(row, "thumb"),
      image_width: row.image_width ?? null,
      image_height: row.image_height ?? null,
    })
  }

  // Backfill sheets whose current-revision version wasn't found (e.g. the
  // current_revision_id points at a row we filtered): use the newest version.
  for (const row of data ?? []) {
    if (images.has(row.drawing_sheet_id)) continue
    images.set(row.drawing_sheet_id, {
      thumbnail_url: imageUrlFromVersion(row, "thumb") ?? imageUrlFromVersion(row, "medium"),
      image_url:
        imageUrlFromVersion(row, "full") ?? imageUrlFromVersion(row, "medium") ?? imageUrlFromVersion(row, "thumb"),
      image_width: row.image_width ?? null,
      image_height: row.image_height ?? null,
    })
  }

  return { images, versionCounts }
}

async function loadPinCounts(
  context: MobileOrgContext,
  projectId: string,
  sheetIds: string[],
): Promise<Map<string, { open: number; total: number }>> {
  const counts = new Map<string, { open: number; total: number }>()
  if (!sheetIds.length) return counts
  const { data, error } = await context.serviceSupabase
    .from("drawing_pins")
    .select("drawing_sheet_id, status")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .in("drawing_sheet_id", sheetIds)
  if (error) return counts
  for (const row of data ?? []) {
    const current = counts.get(row.drawing_sheet_id) ?? { open: 0, total: 0 }
    current.total += 1
    if (row.status === "open" || row.status === "pending" || row.status === "in_progress") current.open += 1
    counts.set(row.drawing_sheet_id, current)
  }
  return counts
}

export async function listMobileDrawingSheets(
  context: MobileOrgContext,
  projectId: string,
): Promise<MobileDrawingSheetDTO[]> {
  await requireProject(context, projectId)

  const { data, error } = await context.serviceSupabase
    .from("drawing_sheets")
    .select(
      "id, drawing_set_id, sheet_number, sheet_title, discipline, current_revision_id, sort_order, updated_at, " +
        "drawing_sets(title), drawing_revisions!drawing_sheets_current_revision_id_fkey(revision_label)",
    )
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .not("current_revision_id", "is", null)
    .order("sort_order", { ascending: true })
    .order("sheet_number", { ascending: true })
    .limit(1000)

  if (error) throw new MobileAPIError(500, "drawing_sheets_unavailable", "Drawing sheets could not be loaded.")

  const rows = data ?? []
  const sheetRows = rows.map((row: any) => ({ id: row.id, current_revision_id: row.current_revision_id }))
  const [{ images, versionCounts }, pinCounts] = await Promise.all([
    loadCurrentVersionImages(context, sheetRows),
    loadPinCounts(context, projectId, sheetRows.map((row) => row.id)),
  ])

  return rows.map((row: any) => mapSheet(row, images.get(row.id), versionCounts.get(row.id) ?? 0, pinCounts.get(row.id)))
}

function mapSheet(
  row: any,
  image: VersionImageInfo | undefined,
  versionCount: number,
  pins: { open: number; total: number } | undefined,
): MobileDrawingSheetDTO {
  const revisionLabel = Array.isArray(row.drawing_revisions)
    ? row.drawing_revisions[0]?.revision_label
    : row.drawing_revisions?.revision_label
  const setTitle = Array.isArray(row.drawing_sets) ? row.drawing_sets[0]?.title : row.drawing_sets?.title
  return {
    id: row.id,
    drawing_set_id: row.drawing_set_id,
    set_title: setTitle ?? null,
    sheet_number: row.sheet_number,
    sheet_title: row.sheet_title ?? null,
    discipline: row.discipline ?? null,
    discipline_label: disciplineLabel(row.discipline ?? null),
    current_revision_label: revisionLabel ?? null,
    version_count: versionCount,
    thumbnail_url: image?.thumbnail_url ?? null,
    image_url: image?.image_url ?? null,
    image_width: image?.image_width ?? null,
    image_height: image?.image_height ?? null,
    open_pins_count: pins?.open ?? 0,
    total_pins_count: pins?.total ?? 0,
    updated_at: row.updated_at,
  }
}

// ============================================================================
// SHEET DETAIL (versions + pins)
// ============================================================================

const PIN_ENTITY_TABLES: Record<string, { table: string; titleColumn: string }> = {
  task: { table: "tasks", titleColumn: "title" },
  rfi: { table: "rfis", titleColumn: "subject" },
  punch_list: { table: "punch_list_items", titleColumn: "title" },
  submittal: { table: "submittals", titleColumn: "title" },
}

async function loadPinsWithEntities(
  context: MobileOrgContext,
  sheetId: string,
): Promise<MobileDrawingPinDTO[]> {
  const { data, error } = await context.serviceSupabase
    .from("drawing_pins")
    .select("id, x_position, y_position, entity_type, entity_id, label, status, created_at")
    .eq("org_id", context.orgId)
    .eq("drawing_sheet_id", sheetId)
    .order("created_at", { ascending: true })
  if (error) throw new MobileAPIError(500, "drawing_pins_unavailable", "Drawing pins could not be loaded.")

  const pins = data ?? []
  const idsByType = new Map<string, string[]>()
  for (const pin of pins) {
    if (!PIN_ENTITY_TABLES[pin.entity_type]) continue
    idsByType.set(pin.entity_type, [...(idsByType.get(pin.entity_type) ?? []), pin.entity_id])
  }

  const entityMap = new Map<string, { title: string | null; status: string | null }>()
  await Promise.all(
    [...idsByType.entries()].map(async ([type, ids]) => {
      const config = PIN_ENTITY_TABLES[type]
      const { data: entities } = await context.serviceSupabase
        .from(config.table)
        .select(`id, ${config.titleColumn}, status`)
        .eq("org_id", context.orgId)
        .in("id", ids)
      for (const entity of ((entities ?? []) as Array<Record<string, any>>)) {
        entityMap.set(entity.id, {
          title: (entity as any)[config.titleColumn] ?? null,
          status: (entity as any).status ?? null,
        })
      }
    }),
  )

  return pins.map((pin: any) => {
    const entity = entityMap.get(pin.entity_id)
    return {
      id: pin.id,
      x_position: Number(pin.x_position),
      y_position: Number(pin.y_position),
      entity_type: pin.entity_type,
      entity_id: pin.entity_id,
      label: pin.label ?? null,
      status: pin.status ?? null,
      entity_title: entity?.title ?? pin.label ?? null,
      entity_status: entity?.status ?? null,
    }
  })
}

async function loadSheetVersions(
  context: MobileOrgContext,
  sheetId: string,
): Promise<MobileDrawingSheetVersionDTO[]> {
  const { data, error } = await context.serviceSupabase
    .from("drawing_sheet_versions")
    .select(
      "id, created_at, thumb_path, medium_path, full_path, thumbnail_url, medium_url, full_url, image_width, image_height, " +
        "drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey(revision_label, notes, app_users!drawing_revisions_created_by_fkey(full_name))",
    )
    .eq("org_id", context.orgId)
    .eq("drawing_sheet_id", sheetId)
    .order("created_at", { ascending: false })
  if (error) throw new MobileAPIError(500, "drawing_versions_unavailable", "Drawing versions could not be loaded.")

  return (data ?? []).map((row: any) => {
    const revision = Array.isArray(row.drawing_revisions) ? row.drawing_revisions[0] : row.drawing_revisions
    const creator = Array.isArray(revision?.app_users) ? revision?.app_users[0] : revision?.app_users
    return {
      id: row.id,
      revision_label: revision?.revision_label ?? null,
      creator_name: creator?.full_name ?? null,
      change_description: revision?.notes ?? null,
      created_at: row.created_at,
      thumbnail_url: imageUrlFromVersion(row, "thumb") ?? imageUrlFromVersion(row, "medium"),
      image_url:
        imageUrlFromVersion(row, "full") ?? imageUrlFromVersion(row, "medium") ?? imageUrlFromVersion(row, "thumb"),
      image_width: row.image_width ?? null,
      image_height: row.image_height ?? null,
    }
  })
}

export async function getMobileDrawingSheetDetail(
  context: MobileOrgContext,
  projectId: string,
  sheetId: string,
): Promise<MobileDrawingSheetDetailDTO> {
  await requireProject(context, projectId)

  const { data: row, error } = await context.serviceSupabase
    .from("drawing_sheets")
    .select(
      "id, drawing_set_id, sheet_number, sheet_title, discipline, current_revision_id, updated_at, " +
        "drawing_sets(title), drawing_revisions!drawing_sheets_current_revision_id_fkey(revision_label)",
    )
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", sheetId)
    .maybeSingle()

  if (error) throw new MobileAPIError(500, "drawing_sheet_unavailable", "The drawing sheet could not be loaded.")
  if (!row) throw new MobileAPIError(404, "drawing_sheet_not_found", "Drawing sheet not found.")

  const sheetRow = row as any
  const [{ images, versionCounts }, pins, versions] = await Promise.all([
    loadCurrentVersionImages(context, [{ id: sheetRow.id, current_revision_id: sheetRow.current_revision_id }]),
    loadPinsWithEntities(context, sheetId),
    loadSheetVersions(context, sheetId),
  ])

  const pinCounts = new Map<string, { open: number; total: number }>([
    [
      sheetId,
      {
        open: pins.filter((pin) => ["open", "pending", "in_progress"].includes(pin.status ?? "")).length,
        total: pins.length,
      },
    ],
  ])

  return {
    sheet: mapSheet(sheetRow, images.get(sheetRow.id), versionCounts.get(sheetRow.id) ?? versions.length, pinCounts.get(sheetId)),
    versions,
    pins,
  }
}
