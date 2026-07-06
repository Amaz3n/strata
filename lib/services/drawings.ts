import type {
  DrawingSetInput,
  DrawingSetUpdate,
  DrawingRevisionInput,
  DrawingRevisionUpdate,
  DrawingSheetInput,
  DrawingSheetUpdate,
  DrawingSheetVersionInput,
  DrawingSetListFilters,
  DrawingSheetListFilters,
  DrawingRevisionListFilters,
  DrawingSetStatus,
  DrawingDiscipline,
  DrawingIssuanceType,
} from "@/lib/validation/drawings"
import {
  drawingSetInputSchema,
  drawingSetUpdateSchema,
  drawingRevisionInputSchema,
  drawingRevisionUpdateSchema,
  drawingSheetInputSchema,
  drawingSheetUpdateSchema,
  drawingSheetVersionInputSchema,
  drawingSetListFiltersSchema,
  drawingSheetListFiltersSchema,
  drawingRevisionListFiltersSchema,
} from "@/lib/validation/drawings"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { buildDrawingsImageUrl } from "@/lib/storage/drawings-urls"
import { getDrawingPdfSignedUrl } from "@/lib/storage/drawings-pdfs-storage"
import {
  deleteTilesObjects,
  listTilesObjects,
} from "@/lib/storage/drawings-tiles-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

// ============================================================================
// TYPES
// ============================================================================

/**
 * PostgREST `.or()` filters are comma/paren-delimited, so raw user input like
 * "FLOOR PLAN (LEVEL 2)" breaks the filter expression. Strip the delimiters —
 * they never appear in sheet numbers and rarely matter for title matching.
 */
function sanitizeIlikeSearch(value: string): string {
  return value.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim()
}

type VersionStorageRow = {
  id: string
  tiles_base_path?: string | null
  extracted_metadata?: Record<string, any> | null
  page_index?: number | null
}

/**
 * Best-effort removal of derived storage (tile pyramids, temp renders) for
 * deleted sheet versions. Tile paths are content-addressed by source hash, so
 * a prefix is only deleted when no surviving version still references it
 * (re-uploading the same PDF reuses the same paths).
 */
async function cleanupSheetVersionStorage(versionRows: VersionStorageRow[]) {
  if (versionRows.length === 0) return
  const supabase = createServiceSupabaseClient()
  const deletedIds = new Set(versionRows.map((row) => row.id))

  const directPaths: string[] = []
  const candidatePrefixes = new Set<string>()

  for (const row of versionRows) {
    const metadata = row.extracted_metadata ?? {}
    if (typeof metadata.temp_png_path === "string" && metadata.temp_png_path) {
      directPaths.push(metadata.temp_png_path)
    }
    if (typeof metadata.source_hash === "string" && metadata.source_hash) {
      // Temp per-page PDF written by the split job (already gone if the page
      // finished processing; discard mid-flight leaves it behind).
      const orgPrefix = row.tiles_base_path?.split("/")[0]
      const pageIndex = row.page_index ?? metadata.page_index
      if (orgPrefix && typeof pageIndex === "number") {
        directPaths.push(`${orgPrefix}/${metadata.source_hash}/temp/page-${pageIndex}.pdf`)
      }
    }
    if (row.tiles_base_path) {
      candidatePrefixes.add(row.tiles_base_path)
    }
  }

  try {
    if (directPaths.length > 0) {
      await deleteTilesObjects({ supabase, paths: directPaths })
    }

    for (const prefix of candidatePrefixes) {
      const { data: stillReferenced } = await supabase
        .from("drawing_sheet_versions")
        .select("id")
        .eq("tiles_base_path", prefix)
        .limit(10)
      const survivors = (stillReferenced ?? []).filter((row) => !deletedIds.has(row.id as string))
      if (survivors.length > 0) continue

      const objects = await listTilesObjects({ supabase, prefix: `${prefix}/`, limit: 1000 })
      if (objects.length > 0) {
        await deleteTilesObjects({ supabase, paths: objects.map((object) => object.name) })
      }
    }
  } catch (error) {
    console.error("[drawings] Failed to clean up version storage:", error)
  }
}

async function refreshDrawingSheetsListView() {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.rpc("refresh_drawing_sheets_list")

  if (error) {
    throw new Error(`Failed to refresh drawing sheets list: ${error.message}`)
  }
}

export interface DrawingSet {
  id: string
  org_id: string
  project_id: string
  title: string
  description?: string
  set_type?: string
  status: DrawingSetStatus
  source_file_id?: string
  total_pages?: number
  processed_pages: number
  processing_stage?: string
  error_message?: string
  created_by?: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  processed_at?: string
  updated_at: string
  // Computed
  sheet_count?: number
}

export interface DrawingRevision {
  id: string
  org_id: string
  project_id: string
  drawing_set_id?: string
  revision_label: string
  issued_date?: string
  notes?: string
  status?: "processing" | "draft" | "published"
  issuance_type?: DrawingIssuanceType
  issued_by?: string
  received_from?: string
  published_at?: string
  published_by?: string
  created_by?: string
  creator_name?: string
  created_at: string
}

export interface DrawingSheet {
  id: string
  org_id: string
  project_id: string
  drawing_set_id: string
  sheet_number: string
  sheet_title?: string
  discipline?: DrawingDiscipline
  current_revision_id?: string
  current_revision_label?: string
  current_revision_creator_name?: string
  // Number of published versions this sheet has (drives the v1/v2/... label)
  version_count?: number | null
  last_modified_by_name?: string
  sort_order: number
  share_with_clients: boolean
  share_with_subs: boolean
  created_at: string
  updated_at: string
  // Denormalized list info (Foundation v2)
  set_title?: string | null
  set_status?: string | null
  open_pins_count?: number | null
  in_progress_pins_count?: number | null
  completed_pins_count?: number | null
  total_pins_count?: number | null
  pins_by_type?: Record<string, number> | null
  pins_by_status?: Record<string, number> | null
  markups_count?: number | null
  // Related data (legacy PDF URLs)
  thumbnail_url?: string
  file_url?: string
  // Optimized image URLs for fast rendering (Phase 1 performance)
  image_thumbnail_url?: string | null
  image_medium_url?: string | null
  image_full_url?: string | null
  image_width?: number | null
  image_height?: number | null
  // Foundation v2 tiles (preferred for viewer)
  tile_base_url?: string | null
  tile_manifest?: Record<string, any> | null
  // Canonical storage paths (Option A public bucket)
  image_thumbnail_path?: string | null
  image_medium_path?: string | null
  image_full_path?: string | null
  tile_manifest_path?: string | null
  tiles_base_path?: string | null
}

export interface DrawingSheetVersion {
  id: string
  org_id: string
  drawing_sheet_id: string
  drawing_revision_id: string
  revision_label?: string
  version_number?: number | string
  creator_name?: string
  change_description?: string
  file_id?: string
  thumbnail_file_id?: string
  page_index?: number
  extracted_metadata: Record<string, any>
  created_at: string
  // Legacy PDF URLs (signed)
  file_url?: string
  thumbnail_url?: string
  // Optimized image URLs (public, for fast rendering)
  image_thumbnail_url?: string | null
  image_medium_url?: string | null
  image_full_url?: string | null
  image_width?: number | null
  image_height?: number | null
  images_generated_at?: string | null
  // Canonical storage paths (Option A)
  image_thumbnail_path?: string | null
  image_medium_path?: string | null
  image_full_path?: string | null
  tile_manifest_path?: string | null
  tiles_base_path?: string | null
  // Resolved tile source for the OpenSeadragon viewer / tile-aware compare
  tile_base_url?: string | null
  tile_manifest?: Record<string, any> | null
}

// ============================================================================
// MAPPERS
// ============================================================================

function toPublicImageUrl(path?: string | null): string | null {
  return buildDrawingsImageUrl(path)
}

function mapDrawingSet(row: any): DrawingSet {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    title: row.title,
    description: row.description ?? undefined,
    set_type: row.set_type ?? undefined,
    status: row.status,
    source_file_id: row.source_file_id ?? undefined,
    total_pages: row.total_pages ?? undefined,
    processed_pages: row.processed_pages ?? 0,
    processing_stage: row.processing_stage ?? undefined,
    error_message: row.error_message ?? undefined,
    created_by: row.created_by ?? undefined,
    creator_name: (row.app_users as any)?.full_name ?? undefined,
    creator_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    created_at: row.created_at,
    processed_at: row.processed_at ?? undefined,
    updated_at: row.updated_at,
    sheet_count: row.sheet_count ?? undefined,
  }
}

function mapDrawingRevision(row: any): DrawingRevision {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    drawing_set_id: row.drawing_set_id ?? undefined,
    revision_label: row.revision_label,
    issued_date: row.issued_date ?? undefined,
    notes: row.notes ?? undefined,
    status: row.status ?? undefined,
    issuance_type: row.issuance_type ?? undefined,
    issued_by: row.issued_by ?? undefined,
    received_from: row.received_from ?? undefined,
    published_at: row.published_at ?? undefined,
    published_by: row.published_by ?? undefined,
    created_by: row.created_by ?? undefined,
    creator_name: (row.app_users as any)?.full_name ?? undefined,
    created_at: row.created_at,
  }
}

function mapDrawingSheet(row: any): DrawingSheet {
  const thumbPath = row.thumb_path ?? row.image_thumbnail_path ?? row.image_thumb_path ?? null
  const mediumPath = row.medium_path ?? row.image_medium_path ?? null
  const fullPath = row.full_path ?? row.image_full_path ?? null
  const currentRevision = (row.drawing_revisions as any) ?? null
  // The optimized list view (drawing_sheets_list_mv) exposes these as flat
  // columns; the joined query nests them under drawing_revisions.
  const currentRevisionLabel =
    currentRevision?.revision_label ?? row.current_revision_label ?? undefined
  const currentRevisionCreator =
    (currentRevision?.app_users as any)?.full_name ??
    (currentRevision?.creator_name as string | undefined) ??
    (row.current_revision_creator_name as string | undefined) ??
    undefined

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    drawing_set_id: row.drawing_set_id,
    sheet_number: row.sheet_number,
    sheet_title: row.sheet_title ?? undefined,
    discipline: row.discipline ?? undefined,
    current_revision_id: row.current_revision_id ?? undefined,
    current_revision_label: currentRevisionLabel,
    current_revision_creator_name: currentRevisionCreator,
    version_count: row.version_count ?? null,
    last_modified_by_name: currentRevisionCreator,
    sort_order: row.sort_order ?? 0,
    share_with_clients: row.share_with_clients ?? false,
    share_with_subs: row.share_with_subs ?? false,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Denormalized list fields (if present)
    set_title: row.set_title ?? null,
    set_status: row.set_status ?? null,
    open_pins_count: row.open_pins_count ?? null,
    in_progress_pins_count: row.in_progress_pins_count ?? null,
    completed_pins_count: row.completed_pins_count ?? null,
    total_pins_count: row.total_pins_count ?? null,
    pins_by_type: row.pins_by_type ?? null,
    pins_by_status: row.pins_by_status ?? null,
    markups_count: row.markups_count ?? null,
    image_thumbnail_path: thumbPath,
    image_medium_path: mediumPath,
    image_full_path: fullPath,
    tile_manifest_path: row.tile_manifest_path ?? null,
    tiles_base_path: row.tiles_base_path ?? null,
    tile_base_url: row.tile_base_url ?? null,
    tile_manifest: row.tile_manifest ?? null,
    image_thumbnail_url:
      toPublicImageUrl(thumbPath) ?? row.image_thumbnail_url ?? row.thumbnail_url ?? null,
    image_medium_url: toPublicImageUrl(mediumPath) ?? row.image_medium_url ?? row.medium_url ?? null,
    image_full_url: toPublicImageUrl(fullPath) ?? row.image_full_url ?? row.full_url ?? null,
    image_width: row.image_width ?? null,
    image_height: row.image_height ?? null,
  }
}

async function listDrawingSheetsOptimized(
  filters: Partial<DrawingSheetListFilters> = {},
  orgId?: string
): Promise<DrawingSheet[]> {
  const parsed = drawingSheetListFiltersSchema.parse(filters)
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  let query = supabase
    .from("drawing_sheets_list_mv")
    .select("*")
    .eq("org_id", resolvedOrgId)

  if (parsed.project_id) {
    query = query.eq("project_id", parsed.project_id)
  }

  if (parsed.drawing_set_id) {
    query = query.eq("drawing_set_id", parsed.drawing_set_id)
  }

  if (parsed.discipline) {
    query = query.eq("discipline", parsed.discipline)
  }

  if (parsed.share_with_clients !== undefined) {
    query = query.eq("share_with_clients", parsed.share_with_clients)
  }

  if (parsed.share_with_subs !== undefined) {
    query = query.eq("share_with_subs", parsed.share_with_subs)
  }

  if (parsed.search) {
    const sanitized = sanitizeIlikeSearch(parsed.search)
    if (sanitized) {
      const searchPattern = `%${sanitized}%`
      query = query.or(`sheet_number.ilike.${searchPattern},sheet_title.ilike.${searchPattern}`)
    }
  }

  const { data, error } = await query
    .order("sort_order", { ascending: true })
    .order("sheet_number", { ascending: true })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list drawing sheets (optimized): ${error.message}`)
  }

  return (data ?? []).map(mapDrawingSheet)
}

/**
 * Register "as of" a chosen revision: returns each sheet's version that was
 * current at that revision's point in time (sheets introduced later are
 * omitted). Backed by the drawing_register_snapshot RPC; rows mirror the
 * sheets-list shape so they map with mapDrawingSheet and render unchanged.
 */
export async function getDrawingRegisterSnapshot(
  drawingSetId: string,
  revisionId: string,
  orgId?: string
): Promise<DrawingSheet[]> {
  const { supabase } = await requireOrgContext(orgId)

  const { data, error } = await supabase.rpc("drawing_register_snapshot", {
    p_set_id: drawingSetId,
    p_revision_id: revisionId,
  })

  if (error) {
    throw new Error(`Failed to load register snapshot: ${error.message}`)
  }

  return (data ?? []).map(mapDrawingSheet)
}

function mapDrawingSheetVersion(row: any): DrawingSheetVersion {
  const thumbPath = row.thumb_path ?? row.image_thumbnail_path ?? row.image_thumb_path ?? null
  const mediumPath = row.medium_path ?? row.image_medium_path ?? null
  const fullPath = row.full_path ?? row.image_full_path ?? null
  const revision = row.drawing_revisions as any

  return {
    id: row.id,
    org_id: row.org_id,
    drawing_sheet_id: row.drawing_sheet_id,
    drawing_revision_id: row.drawing_revision_id,
    revision_label: revision?.revision_label ?? undefined,
    version_number: revision?.revision_label ?? undefined,
    creator_name: (revision?.app_users as any)?.full_name ?? revision?.creator_name ?? undefined,
    change_description: revision?.notes ?? undefined,
    file_id: row.file_id ?? undefined,
    thumbnail_file_id: row.thumbnail_file_id ?? undefined,
    page_index: row.page_index ?? undefined,
    extracted_metadata: row.extracted_metadata ?? {},
    created_at: row.created_at,
    // Optimized image URLs
    image_thumbnail_path: thumbPath,
    image_medium_path: mediumPath,
    image_full_path: fullPath,
    tile_manifest_path: row.tile_manifest_path ?? null,
    tiles_base_path: row.tiles_base_path ?? null,
    tile_base_url: row.tile_base_url ?? null,
    tile_manifest: row.tile_manifest ?? null,
    image_thumbnail_url: toPublicImageUrl(thumbPath) ?? row.thumbnail_url ?? null,
    image_medium_url: toPublicImageUrl(mediumPath) ?? row.medium_url ?? null,
    image_full_url: toPublicImageUrl(fullPath) ?? row.full_url ?? null,
    image_width: row.image_width ?? null,
    image_height: row.image_height ?? null,
    images_generated_at: row.images_generated_at ?? null,
  }
}

// ============================================================================
// DRAWING SETS
// ============================================================================

/**
 * List drawing sets with filters
 */
export async function listDrawingSets(
  filters: Partial<DrawingSetListFilters> = {},
  orgId?: string
): Promise<DrawingSet[]> {
  const parsed = drawingSetListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("drawing_sets")
    .select(`
      id, org_id, project_id, title, description, set_type, status,
      source_file_id, total_pages, processed_pages, processing_stage, error_message,
      created_by, created_at, processed_at, updated_at,
      app_users!drawing_sets_created_by_fkey(full_name, avatar_url),
      drawing_sheets(count)
    `)
    .eq("org_id", resolvedOrgId)

  if (parsed.project_id) {
    query = query.eq("project_id", parsed.project_id)
  }

  if (parsed.status) {
    query = query.eq("status", parsed.status)
  }

  if (parsed.search) {
    query = query.ilike("title", `%${parsed.search}%`)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list drawing sets: ${error.message}`)
  }

  return (data ?? []).map((row) => ({
    ...mapDrawingSet(row),
    sheet_count: (row.drawing_sheets as any)?.[0]?.count ?? 0,
  }))
}

/**
 * Get a single drawing set by ID
 */
export async function getDrawingSet(
  setId: string,
  orgId?: string
): Promise<DrawingSet | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sets")
    .select(`
      id, org_id, project_id, title, description, set_type, status,
      source_file_id, total_pages, processed_pages, processing_stage, error_message,
      created_by, created_at, processed_at, updated_at,
      app_users!drawing_sets_created_by_fkey(full_name, avatar_url),
      drawing_sheets(count)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", setId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get drawing set: ${error.message}`)
  }

  return {
    ...mapDrawingSet(data),
    sheet_count: (data.drawing_sheets as any)?.[0]?.count ?? 0,
  }
}

/**
 * Create a new drawing set
 */
export async function createDrawingSet(
  input: DrawingSetInput,
  orgId?: string
): Promise<DrawingSet> {
  const parsed = drawingSetInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sets")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      title: parsed.title,
      description: parsed.description,
      set_type: parsed.set_type,
      source_file_id: parsed.source_file_id,
      status: "processing",
      created_by: userId,
    })
    .select(`
      id, org_id, project_id, title, description, set_type, status,
      source_file_id, total_pages, processed_pages, error_message,
      created_by, created_at, processed_at, updated_at,
      app_users!drawing_sets_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create drawing set: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_set",
    entityId: data.id as string,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "drawing_set_created",
    entityType: "drawing_set",
    entityId: data.id as string,
    payload: {
      title: parsed.title,
      project_id: parsed.project_id,
    },
  })

  return mapDrawingSet(data)
}

/**
 * Update a drawing set
 */
export async function updateDrawingSet(
  setId: string,
  updates: DrawingSetUpdate,
  orgId?: string
): Promise<DrawingSet> {
  const parsed = drawingSetUpdateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_sets")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", setId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing set not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.description !== undefined) updateData.description = parsed.description
  if (parsed.set_type !== undefined) updateData.set_type = parsed.set_type
  if (parsed.status !== undefined) updateData.status = parsed.status
  if (parsed.processed_at !== undefined) updateData.processed_at = parsed.processed_at
  if (parsed.error_message !== undefined) updateData.error_message = parsed.error_message
  if (parsed.total_pages !== undefined) updateData.total_pages = parsed.total_pages
  if (parsed.processed_pages !== undefined) updateData.processed_pages = parsed.processed_pages

  const { data, error } = await supabase
    .from("drawing_sets")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", setId)
    .select(`
      id, org_id, project_id, title, description, set_type, status,
      source_file_id, total_pages, processed_pages, error_message,
      created_by, created_at, processed_at, updated_at,
      app_users!drawing_sets_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update drawing set: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "drawing_set",
    entityId: setId,
    before: existing,
    after: data,
  })

  return mapDrawingSet(data)
}

/**
 * Delete a drawing set and all related data
 */
export async function deleteDrawingSet(setId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_sets")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", setId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing set not found")
  }

  // Collect derived-storage paths before the cascade removes the version rows.
  const { data: setVersions } = await supabase
    .from("drawing_sheet_versions")
    .select("id, tiles_base_path, extracted_metadata, page_index, drawing_sheets!inner(drawing_set_id)")
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheets.drawing_set_id", setId)

  // Delete cascade will handle sheets, versions, etc.
  const { error } = await supabase
    .from("drawing_sets")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", setId)

  if (error) {
    throw new Error(`Failed to delete drawing set: ${error.message}`)
  }

  await cleanupSheetVersionStorage((setVersions ?? []) as VersionStorageRow[])

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "drawing_set",
    entityId: setId,
    before: existing,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "drawing_set_deleted",
    entityType: "drawing_set",
    entityId: setId,
    payload: { title: existing.title },
  })

  try {
    await supabase.rpc("refresh_drawing_sheets_list")
  } catch (e) {
    console.error("Failed to refresh drawing sheets list after set delete:", e)
  }
}

// ============================================================================
// DRAWING REVISIONS
// ============================================================================

/**
 * List revisions with filters
 */
export async function listDrawingRevisions(
  filters: Partial<DrawingRevisionListFilters> = {},
  orgId?: string
): Promise<DrawingRevision[]> {
  const parsed = drawingRevisionListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("drawing_revisions")
    .select(`
      id, org_id, project_id, drawing_set_id,
      revision_label, issued_date, notes, status,
      issuance_type, issued_by, received_from,
      published_at, published_by, created_by, created_at,
      app_users!drawing_revisions_created_by_fkey(full_name)
    `)
    .eq("org_id", resolvedOrgId)

  if (parsed.project_id) {
    query = query.eq("project_id", parsed.project_id)
  }

  if (parsed.drawing_set_id) {
    query = query.eq("drawing_set_id", parsed.drawing_set_id)
  }

  if (parsed.status) {
    query = query.eq("status", parsed.status)
  } else if (!parsed.include_unpublished) {
    query = query.eq("status", "published")
  }

  const { data, error } = await query
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list drawing revisions: ${error.message}`)
  }

  return (data ?? []).map(mapDrawingRevision)
}

/**
 * Get a single revision
 */
export async function getDrawingRevision(
  revisionId: string,
  orgId?: string
): Promise<DrawingRevision | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_revisions")
    .select(`
      id, org_id, project_id, drawing_set_id,
      revision_label, issued_date, notes, status,
      issuance_type, issued_by, received_from,
      published_at, published_by, created_by, created_at,
      app_users!drawing_revisions_created_by_fkey(full_name)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get drawing revision: ${error.message}`)
  }

  return mapDrawingRevision(data)
}

/**
 * Create a new revision
 */
export async function createDrawingRevision(
  input: DrawingRevisionInput,
  orgId?: string
): Promise<DrawingRevision> {
  const parsed = drawingRevisionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_revisions")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      drawing_set_id: parsed.drawing_set_id,
      revision_label: parsed.revision_label,
      issued_date: parsed.issued_date,
      notes: parsed.notes,
      issuance_type: parsed.issuance_type,
      issued_by: parsed.issued_by,
      received_from: parsed.received_from,
      created_by: userId,
    })
    .select(`
      id, org_id, project_id, drawing_set_id,
      revision_label, issued_date, notes, status,
      issuance_type, issued_by, received_from,
      published_at, published_by, created_by, created_at,
      app_users!drawing_revisions_created_by_fkey(full_name)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create drawing revision: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_revision",
    entityId: data.id as string,
    after: data,
  })

  return mapDrawingRevision(data)
}

/**
 * Update a revision
 */
export async function updateDrawingRevision(
  revisionId: string,
  updates: DrawingRevisionUpdate,
  orgId?: string
): Promise<DrawingRevision> {
  const parsed = drawingRevisionUpdateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_revisions")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing revision not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.revision_label !== undefined) updateData.revision_label = parsed.revision_label
  if (parsed.issued_date !== undefined) updateData.issued_date = parsed.issued_date
  if (parsed.notes !== undefined) updateData.notes = parsed.notes
  if (parsed.issuance_type !== undefined) updateData.issuance_type = parsed.issuance_type
  if (parsed.issued_by !== undefined) updateData.issued_by = parsed.issued_by
  if (parsed.received_from !== undefined) updateData.received_from = parsed.received_from

  const { data, error } = await supabase
    .from("drawing_revisions")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)
    .select(`
      id, org_id, project_id, drawing_set_id,
      revision_label, issued_date, notes, status,
      issuance_type, issued_by, received_from,
      published_at, published_by, created_by, created_at,
      app_users!drawing_revisions_created_by_fkey(full_name)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update drawing revision: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "drawing_revision",
    entityId: revisionId,
    before: existing,
    after: data,
  })

  return mapDrawingRevision(data)
}

/**
 * Delete a revision
 */
export async function deleteDrawingRevision(
  revisionId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_revisions")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing revision not found")
  }

  const { error } = await supabase
    .from("drawing_revisions")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)

  if (error) {
    throw new Error(`Failed to delete drawing revision: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "drawing_revision",
    entityId: revisionId,
    before: existing,
  })
}

// ============================================================================
// DRAWING SHEETS
// ============================================================================

/**
 * List sheets with filters
 */
export async function listDrawingSheets(
  filters: Partial<DrawingSheetListFilters> = {},
  orgId?: string
): Promise<DrawingSheet[]> {
  const parsed = drawingSheetListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("drawing_sheets")
    .select(`
      id, org_id, project_id, drawing_set_id,
      sheet_number, sheet_title, discipline,
      current_revision_id, sort_order,
      share_with_clients, share_with_subs,
      created_at, updated_at,
      drawing_revisions!drawing_sheets_current_revision_id_fkey(
        revision_label,
        created_by,
        app_users!drawing_revisions_created_by_fkey(full_name)
      )
    `)
    .eq("org_id", resolvedOrgId)

  if (parsed.project_id) {
    query = query.eq("project_id", parsed.project_id)
  }

  if (parsed.drawing_set_id) {
    query = query.eq("drawing_set_id", parsed.drawing_set_id)
  }

  if (parsed.discipline) {
    query = query.eq("discipline", parsed.discipline)
  }

  if (parsed.share_with_clients !== undefined) {
    query = query.eq("share_with_clients", parsed.share_with_clients)
  }

  if (parsed.share_with_subs !== undefined) {
    query = query.eq("share_with_subs", parsed.share_with_subs)
  }

  if (parsed.search) {
    const sanitized = sanitizeIlikeSearch(parsed.search)
    if (sanitized) {
      const searchPattern = `%${sanitized}%`
      query = query.or(`sheet_number.ilike.${searchPattern},sheet_title.ilike.${searchPattern}`)
    }
  }

  const { data, error } = await query
    .order("sort_order", { ascending: true })
    .order("sheet_number", { ascending: true })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list drawing sheets: ${error.message}`)
  }

  return (data ?? []).map(mapDrawingSheet)
}

/**
 * List sheets with signed URLs for display
 * Includes optimized image URLs when available (Phase 1 performance)
 */
export async function listDrawingSheetsWithUrls(
  filters: Partial<DrawingSheetListFilters> = {},
  orgId?: string
): Promise<DrawingSheet[]> {
  // Foundation v2: prefer the denormalized list view (single query, counts included).
  if (process.env.NEXT_PUBLIC_FEATURE_TILED_VIEWER === "true") {
    try {
      return await listDrawingSheetsOptimized(filters, orgId)
    } catch (e) {
      console.error("[drawings] Optimized sheets list failed; falling back:", e)
    }
  }

  const sheets = await listDrawingSheets(filters, orgId)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Get the current versions for each sheet (including optimized image URLs).
  // IMPORTANT: Do NOT generate signed URLs here. This function is used for
  // rendering the sheets list/grid, and doing N signed-url calls (per sheet)
  // destroys performance on Vercel/server actions.
  const sheetIds = sheets.map((s) => s.id)
  if (sheetIds.length === 0) return sheets

  // Enrich with current revision creator metadata for "last modified by" in the UI.
  const { data: revisionMetaRows, error: revisionMetaError } = await supabase
    .from("drawing_sheets")
    .select(`
      id,
      current_revision_id,
      drawing_revisions!drawing_sheets_current_revision_id_fkey(
        revision_label,
        created_by,
        app_users!drawing_revisions_created_by_fkey(full_name)
      )
    `)
    .eq("org_id", resolvedOrgId)
    .in("id", sheetIds)

  if (revisionMetaError) {
    console.error("[drawings] Failed to load revision metadata for sheets:", revisionMetaError)
  }

  const revisionMetaBySheetId = new Map<string, {
    current_revision_id?: string
    current_revision_label?: string
    current_revision_creator_name?: string
  }>()

  for (const row of revisionMetaRows ?? []) {
    const revision = (row as any).drawing_revisions as any
    revisionMetaBySheetId.set(row.id as string, {
      current_revision_id: (row as any).current_revision_id ?? undefined,
      current_revision_label: revision?.revision_label ?? undefined,
      current_revision_creator_name:
        (revision?.app_users as any)?.full_name ??
        (revision?.creator_name as string | undefined) ??
        undefined,
    })
  }

  const sheetsWithRevisionMeta = sheets.map((sheet) => {
    const meta = revisionMetaBySheetId.get(sheet.id)
    if (!meta) return sheet
    const lastModifier = meta.current_revision_creator_name
    return {
      ...sheet,
      current_revision_id: meta.current_revision_id ?? sheet.current_revision_id,
      current_revision_label: meta.current_revision_label ?? sheet.current_revision_label,
      current_revision_creator_name:
        meta.current_revision_creator_name ?? sheet.current_revision_creator_name,
      last_modified_by_name: lastModifier ?? sheet.last_modified_by_name,
    }
  })

  const { data: versions, error: versionsError } = await supabase
    .from("drawing_sheet_versions")
    .select(`
      drawing_sheet_id, drawing_revision_id,
      thumb_path, medium_path, full_path,
      tile_manifest, tile_base_url, tile_manifest_path, tiles_base_path,
      thumbnail_url, medium_url, full_url,
      image_width, image_height,
      created_at,
      drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey(status)
    `)
    .in("drawing_sheet_id", sheetIds)
    .order("created_at", { ascending: false })

  if (versionsError) {
    throw new Error(`Failed to load sheet versions: ${versionsError.message}`)
  }

  // The register must show each sheet's *current published* imagery. Versions
  // belonging to a pending draft revision would otherwise win here (they are
  // the newest rows) and leak unreviewed drawings into the live register.
  const currentRevisionBySheetId = new Map<string, string | undefined>()
  for (const sheet of sheetsWithRevisionMeta) {
    currentRevisionBySheetId.set(sheet.id, sheet.current_revision_id)
  }
  const eligibleVersions = (versions ?? []).filter((v: any) => {
    const currentRevisionId = currentRevisionBySheetId.get(v.drawing_sheet_id)
    if (currentRevisionId && v.drawing_revision_id === currentRevisionId) return true
    const revisionStatus = (v.drawing_revisions as any)?.status
    return revisionStatus !== "processing" && revisionStatus !== "draft"
  })
  // Prefer the version that belongs to the sheet's current revision.
  eligibleVersions.sort((a: any, b: any) => {
    const aCurrent = currentRevisionBySheetId.get(a.drawing_sheet_id) === a.drawing_revision_id ? 1 : 0
    const bCurrent = currentRevisionBySheetId.get(b.drawing_sheet_id) === b.drawing_revision_id ? 1 : 0
    if (aCurrent !== bCurrent) return bCurrent - aCurrent
    return String(b.created_at).localeCompare(String(a.created_at))
  })

  // Build a map of sheet ID to version data
  const versionMap = new Map<string, {
    imageThumbnailUrl?: string | null
    imageMediumUrl?: string | null
    imageFullUrl?: string | null
    imageWidth?: number | null
    imageHeight?: number | null
    imageThumbnailPath?: string | null
    imageMediumPath?: string | null
    imageFullPath?: string | null
    tileManifest?: Record<string, any> | null
    tileBaseUrl?: string | null
    tileManifestPath?: string | null
    tilesBasePath?: string | null
  }>()
  for (const v of eligibleVersions) {
    const existing = versionMap.get(v.drawing_sheet_id)
    if (!existing) {
      versionMap.set(v.drawing_sheet_id, {
        imageThumbnailPath: (v as any).thumb_path ?? null,
        imageMediumPath: (v as any).medium_path ?? null,
        imageFullPath: (v as any).full_path ?? null,
        tileManifest: (v as any).tile_manifest ?? null,
        tileBaseUrl: (v as any).tile_base_url ?? null,
        tileManifestPath: (v as any).tile_manifest_path ?? null,
        tilesBasePath: (v as any).tiles_base_path ?? null,
        imageThumbnailUrl:
          toPublicImageUrl((v as any).thumb_path) ?? (v as any).thumbnail_url ?? null,
        imageMediumUrl: toPublicImageUrl((v as any).medium_path) ?? (v as any).medium_url ?? null,
        imageFullUrl: toPublicImageUrl((v as any).full_path) ?? (v as any).full_url ?? null,
        imageWidth: (v as any).image_width ?? null,
        imageHeight: (v as any).image_height ?? null,
      })
    }
  }

  // Include optimized image URLs only. Signed URLs should be generated on-demand
  // (e.g. when the user clicks Download, or when we must fall back to PDF viewer).
  return sheetsWithRevisionMeta.map((sheet) => {
    const versionData = versionMap.get(sheet.id)
    return {
      ...sheet,
      // Include optimized image URLs (Phase 1 performance)
      image_thumbnail_path: versionData?.imageThumbnailPath ?? null,
      image_medium_path: versionData?.imageMediumPath ?? null,
      image_full_path: versionData?.imageFullPath ?? null,
      tile_manifest: versionData?.tileManifest ?? null,
      tile_base_url: versionData?.tileBaseUrl ?? null,
      tile_manifest_path: versionData?.tileManifestPath ?? null,
      tiles_base_path: versionData?.tilesBasePath ?? null,
      image_thumbnail_url: versionData?.imageThumbnailUrl ?? null,
      image_medium_url: versionData?.imageMediumUrl ?? null,
      image_full_url: versionData?.imageFullUrl ?? null,
      image_width: versionData?.imageWidth ?? null,
      image_height: versionData?.imageHeight ?? null,
    }
  })
}

/**
 * Get a single sheet
 */
export async function getDrawingSheet(
  sheetId: string,
  orgId?: string
): Promise<DrawingSheet | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sheets")
    .select(`
      id, org_id, project_id, drawing_set_id,
      sheet_number, sheet_title, discipline,
      current_revision_id, sort_order,
      share_with_clients, share_with_subs,
      created_at, updated_at,
      drawing_revisions!drawing_sheets_current_revision_id_fkey(
        revision_label,
        created_by,
        app_users!drawing_revisions_created_by_fkey(full_name)
      )
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", sheetId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get drawing sheet: ${error.message}`)
  }

  return mapDrawingSheet(data)
}

/**
 * Create a new sheet
 */
export async function createDrawingSheet(
  input: DrawingSheetInput,
  orgId?: string
): Promise<DrawingSheet> {
  const parsed = drawingSheetInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sheets")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      drawing_set_id: parsed.drawing_set_id,
      sheet_number: parsed.sheet_number,
      sheet_title: parsed.sheet_title,
      discipline: parsed.discipline,
      current_revision_id: parsed.current_revision_id,
      sort_order: parsed.sort_order ?? 0,
      share_with_clients: parsed.share_with_clients ?? false,
      share_with_subs: parsed.share_with_subs ?? false,
    })
    .select(`
      id, org_id, project_id, drawing_set_id,
      sheet_number, sheet_title, discipline,
      current_revision_id, sort_order,
      share_with_clients, share_with_subs,
      created_at, updated_at,
      drawing_revisions!drawing_sheets_current_revision_id_fkey(
        revision_label,
        created_by,
        app_users!drawing_revisions_created_by_fkey(full_name)
      )
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create drawing sheet: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_sheet",
    entityId: data.id as string,
    after: data,
  })

  return mapDrawingSheet(data)
}

/**
 * Update a sheet
 */
export async function updateDrawingSheet(
  sheetId: string,
  updates: DrawingSheetUpdate,
  orgId?: string
): Promise<DrawingSheet> {
  const parsed = drawingSheetUpdateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_sheets")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", sheetId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing sheet not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.sheet_number !== undefined) updateData.sheet_number = parsed.sheet_number
  if (parsed.sheet_title !== undefined) updateData.sheet_title = parsed.sheet_title
  if (parsed.discipline !== undefined) updateData.discipline = parsed.discipline
  if (parsed.current_revision_id !== undefined) updateData.current_revision_id = parsed.current_revision_id
  if (parsed.sort_order !== undefined) updateData.sort_order = parsed.sort_order
  if (parsed.share_with_clients !== undefined) updateData.share_with_clients = parsed.share_with_clients
  if (parsed.share_with_subs !== undefined) updateData.share_with_subs = parsed.share_with_subs

  const { data, error } = await supabase
    .from("drawing_sheets")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", sheetId)
    .select(`
      id, org_id, project_id, drawing_set_id,
      sheet_number, sheet_title, discipline,
      current_revision_id, sort_order,
      share_with_clients, share_with_subs,
      created_at, updated_at,
      drawing_revisions!drawing_sheets_current_revision_id_fkey(
        revision_label,
        created_by,
        app_users!drawing_revisions_created_by_fkey(full_name)
      )
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update drawing sheet: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "drawing_sheet",
    entityId: sheetId,
    before: existing,
    after: data,
  })

  await refreshDrawingSheetsListView()

  return mapDrawingSheet(data)
}

/**
 * Bulk update sheet sharing settings
 */
export async function bulkUpdateSheetSharing(
  sheetIds: string[],
  sharing: { share_with_clients?: boolean; share_with_subs?: boolean },
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const updateData: Record<string, any> = {}
  if (sharing.share_with_clients !== undefined) {
    updateData.share_with_clients = sharing.share_with_clients
  }
  if (sharing.share_with_subs !== undefined) {
    updateData.share_with_subs = sharing.share_with_subs
  }

  const { error } = await supabase
    .from("drawing_sheets")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .in("id", sheetIds)

  if (error) {
    throw new Error(`Failed to update sheet sharing: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "drawing_sheets_sharing_updated",
    entityType: "drawing_sheet",
    entityId: sheetIds[0], // Log first sheet as primary
    payload: { sheet_count: sheetIds.length, ...sharing },
  })
}

/**
 * Delete a sheet
 */
export async function deleteDrawingSheet(sheetId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_sheets")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", sheetId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing sheet not found")
  }

  const { data: sheetVersions } = await supabase
    .from("drawing_sheet_versions")
    .select("id, tiles_base_path, extracted_metadata, page_index")
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)

  const { error } = await supabase
    .from("drawing_sheets")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", sheetId)

  if (error) {
    throw new Error(`Failed to delete drawing sheet: ${error.message}`)
  }

  await cleanupSheetVersionStorage((sheetVersions ?? []) as VersionStorageRow[])

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "drawing_sheet",
    entityId: sheetId,
    before: existing,
  })

  // The sheets list reads a materialized view; refresh so the deleted sheet
  // disappears from the register immediately.
  try {
    await supabase.rpc("refresh_drawing_sheets_list")
  } catch (e) {
    console.error("Failed to refresh drawing sheets list after delete:", e)
  }
}

// ============================================================================
// DRAWING SHEET VERSIONS
// ============================================================================

/**
 * List versions for a sheet
 */
export async function listSheetVersions(
  sheetId: string,
  orgId?: string
): Promise<DrawingSheetVersion[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(`
      id, org_id, drawing_sheet_id, drawing_revision_id,
      file_id, thumbnail_file_id, page_index, extracted_metadata, created_at,
      thumb_path, medium_path, full_path, tile_manifest_path, tiles_base_path,
      thumbnail_url, medium_url, full_url, image_width, image_height, images_generated_at,
      drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey(
        revision_label,
        notes,
        app_users!drawing_revisions_created_by_fkey(full_name)
      )
    `)
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list sheet versions: ${error.message}`)
  }

  return (data ?? []).map(mapDrawingSheetVersion)
}

/**
 * List sheet versions with signed URLs for comparison mode
 * Prioritizes optimized images if available, falls back to PDF signed URLs
 */
export async function listSheetVersionsWithUrls(
  sheetId: string,
  expiresIn: number = 3600,
  orgId?: string
): Promise<DrawingSheetVersion[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .select(`
      id, org_id, drawing_sheet_id, drawing_revision_id,
      file_id, thumbnail_file_id, page_index, extracted_metadata, created_at,
      thumb_path, medium_path, full_path, tile_manifest_path, tiles_base_path,
      tile_base_url, tile_manifest,
      thumbnail_url, medium_url, full_url, image_width, image_height, images_generated_at,
      drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey(
        revision_label,
        notes,
        app_users!drawing_revisions_created_by_fkey(full_name)
      ),
      files!drawing_sheet_versions_file_id_fkey(storage_path),
      thumbnail:files!drawing_sheet_versions_thumbnail_file_id_fkey(storage_path)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list sheet versions: ${error.message}`)
  }

  // Generate signed URLs for each version
  const versions: DrawingSheetVersion[] = []
  for (const row of data ?? []) {
    const version = mapDrawingSheetVersion(row)

    // Get file URL
    const fileStoragePath = (row.files as any)?.storage_path
    if (fileStoragePath) {
      version.file_url = await getDrawingPdfSignedUrl({
        supabase,
        orgId: resolvedOrgId,
        path: fileStoragePath,
        expiresIn,
      }) ?? undefined
    }

    // Get thumbnail URL
    const thumbStoragePath = (row.thumbnail as any)?.storage_path
    if (thumbStoragePath) {
      version.thumbnail_url = await getDrawingPdfSignedUrl({
        supabase,
        orgId: resolvedOrgId,
        path: thumbStoragePath,
        expiresIn,
      }) ?? undefined
    }

    versions.push(version)
  }

  return versions
}

/**
 * Create a sheet version
 */
export async function createSheetVersion(
  input: DrawingSheetVersionInput,
  orgId?: string
): Promise<DrawingSheetVersion> {
  const parsed = drawingSheetVersionInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sheet_versions")
    .insert({
      org_id: resolvedOrgId,
      drawing_sheet_id: parsed.drawing_sheet_id,
      drawing_revision_id: parsed.drawing_revision_id,
      file_id: parsed.file_id,
      thumbnail_file_id: parsed.thumbnail_file_id,
      page_index: parsed.page_index,
      extracted_metadata: parsed.extracted_metadata ?? {},
    })
    .select(`
      id, org_id, drawing_sheet_id, drawing_revision_id,
      file_id, thumbnail_file_id, page_index, extracted_metadata, created_at,
      drawing_revisions!drawing_sheet_versions_drawing_revision_id_fkey(revision_label)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create sheet version: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_sheet_version",
    entityId: data.id as string,
    after: data,
  })

  return mapDrawingSheetVersion(data)
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get discipline counts for a project
 */
export async function getDisciplineCounts(
  projectId: string,
  orgId?: string
): Promise<Record<string, number>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_sheets")
    .select("discipline")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (error) {
    throw new Error(`Failed to get discipline counts: ${error.message}`)
  }

  const counts: Record<string, number> = { all: data?.length ?? 0 }
  for (const row of data ?? []) {
    const disc = row.discipline ?? "X"
    counts[disc] = (counts[disc] ?? 0) + 1
  }

  return counts
}

/**
 * Get signed URL for a sheet's current file
 */
export async function getSheetSignedUrl(
  sheetId: string,
  expiresIn: number = 3600,
  orgId?: string
): Promise<string | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Get the sheet with its current revision's version
  const { data: sheet } = await supabase
    .from("drawing_sheets")
    .select("id, current_revision_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", sheetId)
    .single()

  if (!sheet?.current_revision_id) return null

  // Get the version for this revision
  const { data: version } = await supabase
    .from("drawing_sheet_versions")
    .select("file_id, files!drawing_sheet_versions_file_id_fkey(storage_path)")
    .eq("drawing_sheet_id", sheetId)
    .eq("drawing_revision_id", sheet.current_revision_id)
    .single()

  const storagePath = (version?.files as any)?.storage_path
  if (!storagePath) return null

  return getDrawingPdfSignedUrl({
    supabase,
    orgId: resolvedOrgId,
    path: storagePath,
    expiresIn,
  })
}

// ============================================================================
// DRAFT REVISIONS (draft -> publish flow)
// ============================================================================

export interface RevisionVersionPreview {
  version_id: string
  thumbnail_url?: string | null
  tile_base_url?: string | null
  tile_manifest?: Record<string, any> | null
  image_width?: number | null
  image_height?: number | null
}

export interface RevisionDiffSheet {
  sheet_id: string
  change: "updated" | "added"
  is_new_sheet: boolean
  sheet_number: string
  sheet_title?: string | null
  discipline?: DrawingDiscipline | null
  current_sheet_number?: string | null
  current_sheet_title?: string | null
  current_discipline?: DrawingDiscipline | null
  draft: RevisionVersionPreview
  current?: RevisionVersionPreview | null
}

export interface RevisionUnchangedSheet {
  sheet_id: string
  sheet_number: string
  sheet_title?: string | null
  discipline?: DrawingDiscipline | null
  current?: RevisionVersionPreview | null
}

export interface RevisionDraftStatus {
  id: string
  revision_label: string
  status: string
  issuance_type?: DrawingIssuanceType | null
  issued_date?: string | null
  issued_by?: string | null
  received_from?: string | null
  notes?: string | null
  processing_stage?: string | null
  processed_pages?: number | null
  total_pages?: number | null
  error_message?: string | null
  drawing_set_id?: string | null
  project_id: string
}

export interface RevisionDiff {
  revision: RevisionDraftStatus
  updated: RevisionDiffSheet[]
  added: RevisionDiffSheet[]
  unchanged: RevisionUnchangedSheet[]
}

function revisionPreviewFromVersionRow(row: any): RevisionVersionPreview {
  return {
    version_id: row.id,
    thumbnail_url: toPublicImageUrl(row.thumb_path) ?? row.thumbnail_url ?? null,
    tile_base_url: row.tile_base_url ?? null,
    tile_manifest: row.tile_manifest ?? null,
    image_width: row.image_width ?? null,
    image_height: row.image_height ?? null,
  }
}

export async function getDraftRevisionStatus(
  revisionId: string,
  orgId?: string,
): Promise<RevisionDraftStatus | null> {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("drawing_revisions")
    .select("id, project_id, drawing_set_id, revision_label, status, issuance_type, issued_date, issued_by, received_from, notes, processing_stage, processed_pages, total_pages, error_message")
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load revision: ${error.message}`)
  return (data as RevisionDraftStatus) ?? null
}

export async function getPendingDraftRevision(
  projectId: string,
  orgId?: string,
): Promise<RevisionDraftStatus | null> {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("drawing_revisions")
    .select("id, project_id, drawing_set_id, revision_label, status, issuance_type, issued_date, issued_by, received_from, notes, processing_stage, processed_pages, total_pages, error_message")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .in("status", ["processing", "draft"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to load pending revision: ${error.message}`)
  return (data as RevisionDraftStatus) ?? null
}

export async function getRevisionDiff(revisionId: string, orgId?: string): Promise<RevisionDiff> {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const revision = await getDraftRevisionStatus(revisionId, resolvedOrgId)
  if (!revision) throw new Error("Revision not found")

  const { data: draftVersions, error: dvError } = await supabase
    .from("drawing_sheet_versions")
    .select(`
      id, drawing_sheet_id, page_index, extracted_metadata,
      thumb_path, tile_base_url, tile_manifest, thumbnail_url, image_width, image_height,
      drawing_sheets!inner(id, sheet_number, sheet_title, discipline, current_revision_id, sort_order)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("drawing_revision_id", revisionId)
    .order("page_index", { ascending: true })
  if (dvError) throw new Error(`Failed to load draft versions: ${dvError.message}`)

  const updated: RevisionDiffSheet[] = []
  const added: RevisionDiffSheet[] = []
  const draftSheetIds = new Set<string>()

  for (const dv of draftVersions ?? []) {
    const sheet = (dv as any).drawing_sheets
    draftSheetIds.add(sheet.id)
    const proposed = ((dv as any).extracted_metadata?.proposed ?? {}) as any
    const isNew = !sheet.current_revision_id
    const entry: RevisionDiffSheet = {
      sheet_id: sheet.id,
      change: isNew ? "added" : "updated",
      is_new_sheet: isNew,
      sheet_number: proposed.sheet_number ?? sheet.sheet_number,
      sheet_title: proposed.sheet_title ?? sheet.sheet_title ?? null,
      discipline: (proposed.discipline ?? sheet.discipline ?? null) as DrawingDiscipline | null,
      draft: revisionPreviewFromVersionRow(dv),
    }
    if (isNew) {
      added.push(entry)
    } else {
      entry.current_sheet_number = sheet.sheet_number
      entry.current_sheet_title = sheet.sheet_title ?? null
      entry.current_discipline = (sheet.discipline ?? null) as DrawingDiscipline | null
      updated.push(entry)
    }
  }

  // Current published preview for updated sheets.
  const updatedSheetIds = updated.map((u) => u.sheet_id)
  if (updatedSheetIds.length) {
    const { data: currentSheets } = await supabase
      .from("drawing_sheets")
      .select(`
        id, current_revision_id,
        drawing_sheet_versions(id, drawing_revision_id, thumb_path, thumbnail_url, tile_base_url, tile_manifest, image_width, image_height)
      `)
      .eq("org_id", resolvedOrgId)
      .in("id", updatedSheetIds)
    const currentBySheet = new Map<string, any>()
    for (const s of currentSheets ?? []) {
      const versions = (s as any).drawing_sheet_versions ?? []
      const cur = versions.find((v: any) => v.drawing_revision_id === (s as any).current_revision_id)
      if (cur) currentBySheet.set((s as any).id, cur)
    }
    for (const u of updated) {
      const cur = currentBySheet.get(u.sheet_id)
      u.current = cur ? revisionPreviewFromVersionRow(cur) : null
    }
  }

  // Unchanged: live sheets in the project not touched by this draft.
  const { data: liveRows } = await supabase
    .from("drawing_sheets_list_mv")
    .select("id, sheet_number, sheet_title, discipline, current_version_id, thumbnail_url, tile_base_url, tile_manifest, image_width, image_height")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", revision.project_id)
  const unchanged: RevisionUnchangedSheet[] = []
  for (const r of liveRows ?? []) {
    if (draftSheetIds.has((r as any).id)) continue
    unchanged.push({
      sheet_id: (r as any).id,
      sheet_number: (r as any).sheet_number,
      sheet_title: (r as any).sheet_title ?? null,
      discipline: ((r as any).discipline ?? null) as DrawingDiscipline | null,
      current: (r as any).current_version_id
        ? {
            version_id: (r as any).current_version_id,
            thumbnail_url: (r as any).thumbnail_url ?? null,
            tile_base_url: (r as any).tile_base_url ?? null,
            tile_manifest: (r as any).tile_manifest ?? null,
            image_width: (r as any).image_width ?? null,
            image_height: (r as any).image_height ?? null,
          }
        : null,
    })
  }

  return { revision, updated, added, unchanged }
}

export interface PublishRevisionInput {
  revisionId: string
  label?: string
  issuanceType?: DrawingIssuanceType
  issuedDate?: string
  issuedBy?: string
  receivedFrom?: string
  notes?: string
  decisions?: Record<string, boolean>
  sheetEdits?: Record<string, { sheet_number?: string; sheet_title?: string; discipline?: DrawingDiscipline }>
}

export async function publishRevision(input: PublishRevisionInput, orgId?: string): Promise<void> {
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const { data: revision, error: revError } = await supabase
    .from("drawing_revisions")
    .select("id, project_id, drawing_set_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", input.revisionId)
    .single()
  if (revError || !revision) throw new Error(`Revision not found: ${revError?.message}`)
  if (revision.status === "published") throw new Error("Revision already published")

  const { error: publishError } = await supabase.rpc("publish_drawing_revision", {
    p_org_id: resolvedOrgId,
    p_revision_id: input.revisionId,
    p_user_id: userId,
    p_label: input.label?.trim() || null,
    p_issuance_type: input.issuanceType ?? null,
    p_issued_date: input.issuedDate || null,
    p_issued_by: input.issuedBy?.trim() || null,
    p_received_from: input.receivedFrom?.trim() || null,
    p_notes: input.notes?.trim() || null,
    p_decisions: input.decisions ?? {},
    p_sheet_edits: input.sheetEdits ?? {},
  })

  if (publishError) {
    throw new Error(`Failed to publish revision: ${publishError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "drawing_revision_published",
    entityType: "drawing_revision",
    entityId: input.revisionId,
    payload: { project_id: revision.project_id },
  })
}

export async function discardRevision(revisionId: string, orgId?: string): Promise<void> {
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const { data: revision, error: revError } = await supabase
    .from("drawing_revisions")
    .select("id, project_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", revisionId)
    .single()
  if (revError || !revision) throw new Error(`Revision not found: ${revError?.message}`)
  if (revision.status === "published") throw new Error("Cannot discard a published revision")

  const { data: draftVersions } = await supabase
    .from("drawing_sheet_versions")
    .select("id, drawing_sheet_id, tiles_base_path, extracted_metadata, page_index, drawing_sheets!inner(id, current_revision_id)")
    .eq("org_id", resolvedOrgId)
    .eq("drawing_revision_id", revisionId)

  const draftOnlySheetIds = new Set<string>()
  for (const dv of draftVersions ?? []) {
    const sheet = (dv as any).drawing_sheets
    if (!sheet.current_revision_id) draftOnlySheetIds.add(sheet.id)
  }

  await supabase
    .from("drawing_sheet_versions")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("drawing_revision_id", revisionId)

  await cleanupSheetVersionStorage((draftVersions ?? []) as VersionStorageRow[])

  for (const sheetId of draftOnlySheetIds) {
    const { count } = await supabase
      .from("drawing_sheet_versions")
      .select("*", { count: "exact", head: true })
      .eq("drawing_sheet_id", sheetId)
    if (!count) await supabase.from("drawing_sheets").delete().eq("id", sheetId)
  }

  await supabase.from("drawing_revisions").delete().eq("id", revisionId)

  try {
    await supabase.rpc("refresh_drawing_sheets_list")
  } catch (e) {
    console.error("Failed to refresh drawing sheets list:", e)
  }
}
