import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { PreviewMetadata } from "@/lib/files/photo-src"
import { listFileSourceContexts } from "@/lib/services/file-source-contexts"
import { buildInternalFileUrl, type FileSourceContext } from "@/lib/services/files"
import { requireOrgContext } from "@/lib/services/context"
import { createDailyLog } from "@/lib/services/daily-logs"
import { requireProjectPermission } from "@/lib/services/permissions"
import {
  bulkPhotoMetadataSchema,
  deletePhotoAlbumSchema,
  ensurePhotoDailyLogSchema,
  listProjectPhotosSchema,
  photoAlbumInputSchema,
  photoCaptureMetadataSchema,
  photoMetadataInputSchema,
  renamePhotoAlbumSchema,
  UNASSIGNED,
  type BulkPhotoMetadataInput,
  type ListProjectPhotosInput,
  type PhotoCaptureMetadata,
  type ProjectPhotoFilters,
} from "@/lib/validation/photos"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

/**
 * How many rows to pull per round trip when a filter has to be applied after the
 * database has done its part. Only `source_type` is in that position: which
 * records a photo hangs off lives across six tables and is resolved by
 * `hydratePhotoRows`, not by the view.
 */
const SCAN_BATCH_SIZE = 96

/**
 * And how many of those round trips one request is allowed. Everything else
 * filters in SQL, so this bounds the single remaining case instead of letting a
 * rare `source_type` walk an entire project's photo history in one server action.
 * Running out returns a short page WITH its cursor, so the caller keeps paging
 * rather than being told there is nothing left.
 */
const MAX_SCAN_BATCHES = 4

/** The width the grid renders at on a 2x display. */
const GRID_PREVIEW_WIDTH = 480

const ENTRY_COLUMNS =
  "file_id, photo_id, org_id, project_id, daily_log_id, photo_daily_log_id, photo_task_id, " +
  "file_name, storage_path, file_visibility, mime_type, size_bytes, uploaded_by, uploaded_at, " +
  "taken_at, album_id, location_id, trade_company_id, latitude, longitude, ai_caption, ai_tags, " +
  "ai_processed_at, curated_visibility, media_kind, preview_status, preview_thumbhash, " +
  "preview_width, preview_height, has_preview_ladder, preview_widths"

type PhotoEntryRow = {
  file_id: string
  photo_id: string
  org_id: string
  project_id: string
  daily_log_id: string | null
  photo_daily_log_id: string | null
  photo_task_id: string | null
  file_name: string
  storage_path: string
  file_visibility: string
  mime_type: string | null
  size_bytes: number | null
  uploaded_by: string | null
  uploaded_at: string
  taken_at: string
  album_id: string | null
  location_id: string | null
  trade_company_id: string | null
  latitude: number | string | null
  longitude: number | string | null
  ai_caption: string | null
  ai_tags: string[] | null
  ai_processed_at: string | null
  curated_visibility: string
  media_kind: string
  preview_status: string | null
  preview_thumbhash: string | null
  preview_width: number | null
  preview_height: number | null
  has_preview_ladder: boolean
  preview_widths: number[] | null
}

export type ProjectPhotoSource = {
  type: string
  entity_id: string
  label: string
  href: string
  location_id: string | null
  location: string | null
  source_date: string | null
}

export type ProjectPhoto = {
  id: string
  photo_id: string
  org_id: string
  project_id: string
  file_name: string
  storage_path: string
  visibility: string
  mime_type: string | null
  media_kind: "image" | "video"
  size_bytes: number | null
  /** When the file landed in Arc. */
  created_at: string
  /** When the shutter fired, as well as it is known. The timeline's axis. */
  taken_at: string
  uploaded_by: string | null
  uploader_name: string | null
  uploader_avatar: string | null
  /**
   * A grid-sized rendition, not the original. A phone photo is several megabytes
   * and a page of thirty of them used to download every full-resolution byte.
   */
  thumbnail_url: string
  /** The file itself, for the viewer and print. Permission-checked per request
   *  and never expires, unlike a presigned URL held in client state. */
  download_url: string
  /**
   * What the preview ladder produced, in the shape `HashImage` reads: the rung
   * widths for a srcset, the source dimensions, and the thumbhash it paints
   * while the real pixels arrive.
   */
  preview: PreviewMetadata
  sources: ProjectPhotoSource[]
  primary_source: ProjectPhotoSource
  location_ids: string[]
  locations: string[]
  album_id: string | null
  location_id: string | null
  trade_company_id: string | null
  latitude: number | null
  longitude: number | null
  ai_caption: string | null
  ai_tags: string[]
  ai_processed_at: string | null
  curated_visibility: "internal" | "client"
}

export type ProjectPhotoPage = {
  photos: ProjectPhoto[]
  next_cursor: string | null
}

export type ProjectPhotoUploader = { id: string; name: string }

export type PhotoAlbum = {
  id: string
  name: string
  description: string | null
  photo_count: number
  created_at: string
  updated_at: string
}

export type ProjectPhotoFacets = {
  total: number
  geotagged: number
  videos: number
}

type Cursor = { takenAt: string; id: string }

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor")
    const cursor = parsed as Record<string, unknown>
    if (typeof cursor.takenAt !== "string" || typeof cursor.id !== "string") throw new Error("Invalid cursor")
    if (Number.isNaN(Date.parse(cursor.takenAt))) throw new Error("Invalid cursor")
    return { takenAt: cursor.takenAt, id: cursor.id }
  } catch {
    throw new Error("Invalid photo cursor")
  }
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** `%` and `_` are LIKE wildcards, so a search for "50%" must not match everything. */
function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

function addSource(map: Map<string, ProjectPhotoSource[]>, fileId: string | null | undefined, source: ProjectPhotoSource) {
  if (!fileId) return
  const sources = map.get(fileId) ?? []
  const key = `${source.type}:${source.entity_id}`
  if (!sources.some((existing) => `${existing.type}:${existing.entity_id}` === key)) sources.push(source)
  map.set(fileId, sources)
}

function fallbackSource(projectId: string, fileId: string): ProjectPhotoSource {
  return {
    type: "files",
    entity_id: fileId,
    label: "Files",
    href: `/projects/${projectId}/documents`,
    location_id: null,
    location: null,
    source_date: null,
  }
}

function contextToSource(projectId: string, context: FileSourceContext): ProjectPhotoSource {
  return {
    type: context.type,
    entity_id: context.entity_id,
    label: context.label,
    href: context.href ?? `/projects/${projectId}/documents`,
    location_id: null,
    location: null,
    source_date: null,
  }
}

/**
 * Which URL a photo renders from.
 *
 * `generate_file_preview` writes a responsive ladder of AVIF/WebP renditions for
 * every image; `/api/files/:id/preview` picks the rung. A file whose job has not
 * run yet — or a video, which has no ladder — falls back to the original, which
 * the browser can still display.
 */
function thumbnailUrl(row: PhotoEntryRow): string {
  if (row.has_preview_ladder || row.preview_status === "ready") {
    return `/api/files/${row.file_id}/preview?w=${GRID_PREVIEW_WIDTH}`
  }
  const isHeic = row.mime_type === "image/heic" || row.mime_type === "image/heif" || /\.hei[cf]$/i.test(row.file_name)
  // A HEIC original is not renderable anywhere; the preview route generates one
  // on demand rather than 404ing.
  if (isHeic) return `/api/files/${row.file_id}/preview`
  return buildInternalFileUrl(row.file_id)
}

async function hydratePhotoRows(
  supabase: SupabaseClient,
  rows: PhotoEntryRow[],
  projectId: string,
  orgId: string,
  uploaderNames: Map<string, { name: string | null; avatar: string | null }>,
): Promise<ProjectPhoto[]> {
  if (rows.length === 0) return []
  const fileIds = rows.map((row) => row.file_id)

  const [contextsByFileId, linksResult, inspectionItemsResult, observationsResult, incidentsResult] = await Promise.all([
    listFileSourceContexts(fileIds, orgId),
    supabase.from("file_links").select("file_id, entity_type, entity_id").eq("org_id", orgId).eq("project_id", projectId).in("file_id", fileIds),
    // `inspections!inner` with the project filter on the embedded table keeps the
    // join in SQL. Reading every org inspection item and dropping the ones from
    // other projects in JavaScript is what this used to do.
    supabase.from("inspection_items")
      .select("id, photo_file_id, inspection:inspections!inner(id, project_id, inspection_number, title, inspected_at, location_id, location)")
      .eq("org_id", orgId).eq("inspection.project_id", projectId).in("photo_file_id", fileIds),
    supabase.from("observations").select("id, photo_file_id, observation_number, kind, created_at, location_id, location").eq("org_id", orgId).eq("project_id", projectId).in("photo_file_id", fileIds),
    supabase.from("safety_incidents").select("id, photo_file_id, incident_number, occurred_at, location_id, location").eq("org_id", orgId).eq("project_id", projectId).in("photo_file_id", fileIds),
  ])

  for (const result of [linksResult, inspectionItemsResult, observationsResult, incidentsResult]) {
    if (result.error) throw new Error(`Failed to load photo sources: ${result.error.message}`)
  }

  const links = linksResult.data ?? []
  const punchIds = links.filter((link) => link.entity_type === "punch_item").map((link) => link.entity_id)
  const rfiIds = links.filter((link) => link.entity_type === "rfi").map((link) => link.entity_id)
  const linkedDailyLogIds = links.filter((link) => link.entity_type === "daily_log").map((link) => link.entity_id)
  const taskIds = rows.map((row) => row.photo_task_id).filter((id): id is string => Boolean(id))
  const dailyLogIds = Array.from(new Set([
    ...rows.flatMap((row) => [row.daily_log_id, row.photo_daily_log_id]).filter((id): id is string => Boolean(id)),
    ...linkedDailyLogIds,
  ]))

  const [dailyLogsResult, punchResult, rfisResult, tasksResult] = await Promise.all([
    dailyLogIds.length
      ? supabase.from("daily_logs").select("id, log_date").eq("org_id", orgId).eq("project_id", projectId).in("id", dailyLogIds)
      : Promise.resolve({ data: [], error: null }),
    punchIds.length
      ? supabase.from("punch_items").select("id, title, created_at, location_id, location").eq("org_id", orgId).eq("project_id", projectId).in("id", punchIds)
      : Promise.resolve({ data: [], error: null }),
    rfiIds.length
      ? supabase.from("rfis").select("id, rfi_number, subject, created_at, location").eq("org_id", orgId).eq("project_id", projectId).in("id", rfiIds)
      : Promise.resolve({ data: [], error: null }),
    taskIds.length
      ? supabase.from("tasks").select("id, title, created_at, metadata").eq("org_id", orgId).eq("project_id", projectId).in("id", taskIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  for (const result of [dailyLogsResult, punchResult, rfisResult, tasksResult]) {
    if (result.error) throw new Error(`Failed to hydrate photo source details: ${result.error.message}`)
  }

  const sources = new Map<string, ProjectPhotoSource[]>()
  const fileIdsByDailyLog = new Map<string, string[]>()
  const pushDailyLog = (logId: string | null, fileId: string) => {
    if (!logId) return
    fileIdsByDailyLog.set(logId, [...(fileIdsByDailyLog.get(logId) ?? []), fileId])
  }
  for (const row of rows) {
    pushDailyLog(row.daily_log_id, row.file_id)
    pushDailyLog(row.photo_daily_log_id, row.file_id)
  }
  for (const link of links) {
    if (link.entity_type === "daily_log") pushDailyLog(link.entity_id, link.file_id)
  }
  for (const log of dailyLogsResult.data ?? []) {
    for (const fileId of fileIdsByDailyLog.get(log.id) ?? []) {
      addSource(sources, fileId, {
        type: "daily_log",
        entity_id: log.id,
        label: `Daily log · ${log.log_date}`,
        href: `/projects/${projectId}/daily-logs?logId=${log.id}`,
        location_id: null,
        location: null,
        source_date: log.log_date,
      })
    }
  }

  const linksByEntity = new Map<string, string[]>()
  for (const link of links) linksByEntity.set(`${link.entity_type}:${link.entity_id}`, [...(linksByEntity.get(`${link.entity_type}:${link.entity_id}`) ?? []), link.file_id])
  for (const punch of punchResult.data ?? []) {
    for (const fileId of linksByEntity.get(`punch_item:${punch.id}`) ?? []) addSource(sources, fileId, {
      type: "punch_item", entity_id: punch.id, label: `Punch · ${punch.title}`, href: `/projects/${projectId}/punch?item=${punch.id}`,
      location_id: punch.location_id ?? null, location: punch.location ?? null, source_date: punch.created_at,
    })
  }
  for (const rfi of rfisResult.data ?? []) {
    for (const fileId of linksByEntity.get(`rfi:${rfi.id}`) ?? []) addSource(sources, fileId, {
      type: "rfi", entity_id: rfi.id, label: `RFI #${rfi.rfi_number} · ${rfi.subject}`, href: `/projects/${projectId}/rfis?rfi=${rfi.id}`,
      location_id: null, location: rfi.location ?? null, source_date: rfi.created_at,
    })
  }
  const filesByTask = new Map<string, string[]>()
  for (const row of rows) {
    if (row.photo_task_id) filesByTask.set(row.photo_task_id, [...(filesByTask.get(row.photo_task_id) ?? []), row.file_id])
  }
  for (const task of tasksResult.data ?? []) {
    const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata as Record<string, unknown> : {}
    const location = typeof metadata.location === "string" ? metadata.location : null
    for (const fileId of filesByTask.get(task.id) ?? []) addSource(sources, fileId, {
      type: "task", entity_id: task.id, label: `Task · ${task.title}`, href: `/projects/${projectId}/tasks?task=${task.id}`,
      location_id: null, location, source_date: task.created_at,
    })
  }
  for (const item of inspectionItemsResult.data ?? []) {
    const inspection = relationOne(item.inspection)
    if (!inspection) continue
    addSource(sources, item.photo_file_id, {
      type: "inspection", entity_id: inspection.id, label: `Inspection #${inspection.inspection_number} · ${inspection.title}`,
      href: `/projects/${projectId}/inspections?inspection=${inspection.id}`, location_id: inspection.location_id ?? null,
      location: inspection.location ?? null, source_date: inspection.inspected_at ?? null,
    })
  }
  for (const observation of observationsResult.data ?? []) addSource(sources, observation.photo_file_id, {
    type: "observation", entity_id: observation.id, label: `Observation #${observation.observation_number} · ${observation.kind}`,
    href: `/projects/${projectId}/safety?tab=observations&observation=${observation.id}`, location_id: observation.location_id ?? null,
    location: observation.location ?? null, source_date: observation.created_at,
  })
  for (const incident of incidentsResult.data ?? []) addSource(sources, incident.photo_file_id, {
    type: "safety_incident", entity_id: incident.id, label: `Incident #${incident.incident_number}`,
    href: `/projects/${projectId}/safety?tab=incidents&incident=${incident.id}`, location_id: incident.location_id ?? null,
    location: incident.location ?? null, source_date: incident.occurred_at,
  })

  for (const row of rows) {
    for (const context of contextsByFileId[row.file_id] ?? []) addSource(sources, row.file_id, contextToSource(projectId, context))
  }

  return rows.map((row) => {
    const rowSources = sources.get(row.file_id) ?? []
    const effectiveSources = rowSources.length ? rowSources : [fallbackSource(projectId, row.file_id)]
    const uploader = row.uploaded_by ? uploaderNames.get(row.uploaded_by) : undefined
    const locationIds = Array.from(new Set([...effectiveSources.map((source) => source.location_id), row.location_id].filter((id): id is string => Boolean(id))))
    const locations = Array.from(new Set(effectiveSources.map((source) => source.location).filter((value): value is string => Boolean(value))))
    return {
      id: row.file_id,
      photo_id: row.photo_id,
      org_id: row.org_id,
      project_id: row.project_id,
      file_name: row.file_name,
      storage_path: row.storage_path,
      visibility: row.file_visibility,
      mime_type: row.mime_type,
      media_kind: row.media_kind === "video" ? "video" as const : "image" as const,
      size_bytes: row.size_bytes,
      created_at: row.uploaded_at,
      taken_at: row.taken_at,
      uploaded_by: row.uploaded_by,
      uploader_name: uploader?.name ?? null,
      uploader_avatar: uploader?.avatar ?? null,
      thumbnail_url: thumbnailUrl(row),
      download_url: buildInternalFileUrl(row.file_id),
      preview: {
        width: row.preview_width,
        height: row.preview_height,
        thumbhash: row.preview_thumbhash,
        sizes: row.preview_widths?.map((width) => ({ width })) ?? null,
      },
      sources: effectiveSources,
      primary_source: effectiveSources[0],
      location_ids: locationIds,
      locations,
      album_id: row.album_id,
      location_id: row.location_id,
      trade_company_id: row.trade_company_id,
      latitude: toNumber(row.latitude),
      longitude: toNumber(row.longitude),
      ai_caption: row.ai_caption,
      ai_tags: row.ai_tags ?? [],
      ai_processed_at: row.ai_processed_at,
      curated_visibility: row.curated_visibility === "client" ? "client" as const : "internal" as const,
    }
  })
}

/** Name and avatar for a page's uploaders, in one query instead of a join that
 *  repeats the same handful of people across every row. */
async function loadUploaders(
  supabase: SupabaseClient,
  userIds: Array<string | null>,
): Promise<Map<string, { name: string | null; avatar: string | null }>> {
  const ids = Array.from(new Set(userIds.filter((id): id is string => Boolean(id))))
  const names = new Map<string, { name: string | null; avatar: string | null }>()
  if (ids.length === 0) return names
  const { data, error } = await supabase.from("app_users").select("id, full_name, avatar_url").in("id", ids)
  if (error) throw new Error(`Failed to load photo uploaders: ${error.message}`)
  for (const row of data ?? []) names.set(row.id, { name: row.full_name ?? null, avatar: row.avatar_url ?? null })
  return names
}

/** The half-open UTC window a date filter means. */
function dateWindow(filters: ProjectPhotoFilters): { from?: string; toExclusive?: string } {
  const from = filters.date_from ? `${filters.date_from}T00:00:00.000Z` : undefined
  if (!filters.date_to) return { from }
  const exclusiveEnd = new Date(`${filters.date_to}T00:00:00.000Z`)
  exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1)
  return { from, toExclusive: exclusiveEnd.toISOString() }
}

function matchesSourceFilter(photo: ProjectPhoto, sourceType: string) {
  // "Files" means a photo nothing else claims — it was uploaded to the project
  // rather than filed against a record.
  if (sourceType === "files") return photo.sources.every((source) => source.type === "files")
  return photo.sources.some((source) => source.type === sourceType)
}

export async function listProjectPhotos(input: ListProjectPhotosInput, orgId?: string): Promise<ProjectPhotoPage> {
  const parsed = listProjectPhotosSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.projectId, "docs.read")

  const filters = parsed.filters
  const sourceType = filters.source_type
  const { from, toExclusive } = dateWindow(filters)
  let cursor = decodeCursor(parsed.cursor)
  const photos: ProjectPhoto[] = []

  for (let batch = 0; batch < MAX_SCAN_BATCHES; batch += 1) {
    // Without a source filter the database returns exactly the page, so there is
    // nothing to over-fetch and nothing to loop over.
    const take = sourceType ? SCAN_BATCH_SIZE : parsed.limit - photos.length

    // Every filter but `source_type` is applied here, by the database. The list
    // used to read batches of rows and drop the non-matching ones in JavaScript,
    // which turned a search for a rare tag into a walk of the entire project.
    let query = supabase
      .from("project_photo_entries")
      .select(ENTRY_COLUMNS)
      .eq("org_id", resolvedOrgId)
      .eq("project_id", parsed.projectId)
      .order("taken_at", { ascending: false })
      .order("file_id", { ascending: false })
      .limit(take)

    if (from) query = query.gte("taken_at", from)
    if (toExclusive) query = query.lt("taken_at", toExclusive)
    if (filters.uploader_id) query = query.eq("uploaded_by", filters.uploader_id)
    if (filters.album_id) {
      query = filters.album_id === UNASSIGNED ? query.is("album_id", null) : query.eq("album_id", filters.album_id)
    }
    if (filters.location_id) {
      query = filters.location_id === UNASSIGNED ? query.is("location_id", null) : query.eq("location_id", filters.location_id)
    }
    if (filters.trade_company_id) query = query.eq("trade_company_id", filters.trade_company_id)
    if (filters.visibility) query = query.eq("curated_visibility", filters.visibility)
    if (filters.media_kind) query = query.eq("media_kind", filters.media_kind)
    if (filters.geotagged) query = query.not("latitude", "is", null).not("longitude", "is", null)
    if (filters.search) query = query.ilike("search_text", `%${escapeLikePattern(filters.search.toLowerCase())}%`)
    if (cursor) {
      query = query.or(`taken_at.lt.${cursor.takenAt},and(taken_at.eq.${cursor.takenAt},file_id.lt.${cursor.id})`)
    }

    const { data, error } = await query
    if (error) throw new Error(`Failed to load project photos: ${error.message}`)
    const rows = (data ?? []) as unknown as PhotoEntryRow[]
    if (rows.length === 0) return { photos, next_cursor: null }

    const uploaders = await loadUploaders(supabase, rows.map((row) => row.uploaded_by))
    const hydrated = await hydratePhotoRows(supabase, rows, parsed.projectId, resolvedOrgId, uploaders)

    for (const photo of hydrated) {
      cursor = { takenAt: photo.taken_at, id: photo.id }
      if (!sourceType || matchesSourceFilter(photo, sourceType)) photos.push(photo)
      if (photos.length === parsed.limit) return { photos, next_cursor: encodeCursor(cursor) }
    }

    // A short answer from the database means there is nothing behind it.
    if (rows.length < take) return { photos, next_cursor: null }
    if (!sourceType) break
  }

  return { photos, next_cursor: cursor ? encodeCursor(cursor) : null }
}

export async function listProjectPhotoUploaders(projectId: string, orgId?: string): Promise<ProjectPhotoUploader[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")

  // One narrow column, then one lookup for the handful of distinct people in it.
  // Joining app_users onto every photo row repeated the same names hundreds of
  // times to build a list that is usually shorter than a dozen.
  const { data, error } = await supabase
    .from("project_photo_entries")
    .select("uploaded_by")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .not("uploaded_by", "is", null)
    .limit(5000)
  if (error) throw new Error(`Failed to load photo uploaders: ${error.message}`)

  const uploaders = await loadUploaders(supabase, (data ?? []).map((row) => row.uploaded_by))
  return Array.from(uploaders, ([id, user]) => ({ id, name: user.name?.trim() || "Unknown user" }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Counts the toolbar reports and the map view gates on, in one round trip each
 *  and without reading a single row. */
export async function getProjectPhotoFacets(projectId: string, orgId?: string): Promise<ProjectPhotoFacets> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")

  const base = () => supabase
    .from("project_photo_entries")
    .select("file_id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  const [total, geotagged, videos] = await Promise.all([
    base(),
    base().not("latitude", "is", null).not("longitude", "is", null),
    base().eq("media_kind", "video"),
  ])

  for (const result of [total, geotagged, videos]) {
    if (result.error) throw new Error(`Failed to count project photos: ${result.error.message}`)
  }

  return {
    total: total.count ?? 0,
    geotagged: geotagged.count ?? 0,
    videos: videos.count ?? 0,
  }
}

export async function ensureTodayDailyLogForPhotos(projectId: string, localDate: string, orgId?: string): Promise<{ id: string }> {
  const parsed = ensurePhotoDailyLogSchema.parse({ projectId, localDate })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.projectId, "daily_log.write")
  const { data: existing, error } = await supabase.from("daily_logs").select("id").eq("org_id", resolvedOrgId)
    .eq("project_id", parsed.projectId).eq("log_date", parsed.localDate).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`Failed to find today's daily log: ${error.message}`)
  if (existing) return existing
  const created = await createDailyLog({ input: { project_id: parsed.projectId, date: parsed.localDate, summary: "Jobsite photos" }, orgId: resolvedOrgId })
  return { id: created.id }
}

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

export async function listPhotoAlbums(projectId: string, orgId?: string): Promise<PhotoAlbum[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")

  const { data, error } = await supabase.from("photo_albums")
    .select("id,name,description,created_at,updated_at")
    .eq("org_id", resolvedOrgId).eq("project_id", projectId).order("name").limit(250)
  if (error) throw new Error(`Failed to list photo albums: ${error.message}`)
  const albums = data ?? []
  if (albums.length === 0) return []

  // One count per album rather than a row-by-row tally: the list shows how full
  // each album is, and an empty one is the thing a curator wants to see.
  const counts = await Promise.all(albums.map(async (album) => {
    const { count, error: countError } = await supabase
      .from("project_photo_entries")
      .select("file_id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("project_id", projectId)
      .eq("album_id", album.id)
    if (countError) throw new Error(`Failed to count album photos: ${countError.message}`)
    return count ?? 0
  }))

  return albums.map((album, index) => ({
    id: album.id,
    name: album.name,
    description: album.description ?? null,
    photo_count: counts[index],
    created_at: album.created_at,
    updated_at: album.updated_at,
  }))
}

export async function createPhotoAlbum(input: unknown, orgId?: string) {
  const parsed = photoAlbumInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "docs.upload")
  const payload = { org_id: resolvedOrgId, project_id: parsed.project_id, name: parsed.name, description: parsed.description ?? null, created_by: userId }
  const { data, error } = await supabase.from("photo_albums").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to create photo album: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "photo_album_created", entityType: "photo_album", entityId: data.id, payload: { project_id: parsed.project_id, name: parsed.name } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "photo_album", entityId: data.id, after: payload }),
  ])
  return data
}

export async function renamePhotoAlbum(input: unknown, orgId?: string) {
  const parsed = renamePhotoAlbumSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "docs.upload")

  const { data: existing } = await supabase.from("photo_albums").select("*")
    .eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("id", parsed.album_id).maybeSingle()
  if (!existing) throw new Error("Album not found")

  const patch = { name: parsed.name, description: parsed.description ?? null }
  const { data, error } = await supabase.from("photo_albums").update(patch)
    .eq("org_id", resolvedOrgId).eq("id", parsed.album_id).select("*").single()
  if (error || !data) throw new Error(`Failed to rename photo album: ${error?.message}`)

  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "photo_album_updated", entityType: "photo_album", entityId: data.id, payload: { project_id: parsed.project_id, name: parsed.name } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "photo_album", entityId: data.id, before: existing, after: data }),
  ])
  return data
}

/**
 * Deleting an album never deletes photographs. The membership is cleared first,
 * explicitly, so the caller can tell the person how many photos just returned to
 * unfiled — "album deleted" on its own reads like the pictures went with it.
 */
export async function deletePhotoAlbum(input: unknown, orgId?: string): Promise<{ id: string; released: number }> {
  const parsed = deletePhotoAlbumSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "docs.upload")

  const { data: existing } = await supabase.from("photo_albums").select("*")
    .eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("id", parsed.album_id).maybeSingle()
  if (!existing) throw new Error("Album not found")

  const { data: released, error: releaseError } = await supabase.from("photos")
    .update({ album_id: null })
    .eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("album_id", parsed.album_id)
    .select("id")
  if (releaseError) throw new Error(`Failed to empty photo album: ${releaseError.message}`)

  const { error } = await supabase.from("photo_albums").delete().eq("org_id", resolvedOrgId).eq("id", parsed.album_id)
  if (error) throw new Error(`Failed to delete photo album: ${error.message}`)

  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "photo_album_deleted", entityType: "photo_album", entityId: parsed.album_id, payload: { project_id: parsed.project_id, released: released?.length ?? 0 } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "photo_album", entityId: parsed.album_id, before: existing }),
  ])
  return { id: parsed.album_id, released: released?.length ?? 0 }
}

// ---------------------------------------------------------------------------
// Photo metadata
// ---------------------------------------------------------------------------

async function requirePhotoRecord(
  supabase: SupabaseClient,
  orgId: string,
  projectId: string,
  fileId: string,
) {
  const { data, error } = await supabase.from("photos").select("*")
    .eq("org_id", orgId).eq("project_id", projectId).eq("file_id", fileId).maybeSingle()
  if (error) throw new Error(`Failed to load photo: ${error.message}`)
  // A file gets its photo record from a trigger on insert, so a miss here means
  // the file is not this project's, not that the record is late.
  if (!data) throw new Error("Photo not found")
  return data
}

export async function updatePhotoMetadata(input: unknown, orgId?: string) {
  const parsed = photoMetadataInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "docs.upload")

  const existing = await requirePhotoRecord(supabase, resolvedOrgId, parsed.project_id, parsed.file_id)

  const patch = {
    album_id: parsed.album_id, location_id: parsed.location_id, trade_company_id: parsed.trade_company_id,
    taken_at: parsed.taken_at, latitude: parsed.latitude, longitude: parsed.longitude, visibility: parsed.visibility,
  }
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  if (Object.keys(cleanPatch).length === 0) return existing

  const { data, error } = await supabase.from("photos").update(cleanPatch)
    .eq("org_id", resolvedOrgId).eq("id", existing.id).select("*").single()
  if (error || !data) throw new Error(`Failed to update photo: ${error?.message}`)

  await Promise.all([
    recordEvent({
      orgId: resolvedOrgId, actorId: userId,
      eventType: parsed.visibility === "client" ? "photo_published" : "photo_updated",
      entityType: "photo", entityId: data.id,
      payload: { project_id: parsed.project_id, file_id: parsed.file_id, visibility: data.visibility },
    }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "photo", entityId: data.id, before: existing, after: data }),
  ])
  return data
}

/**
 * The same patch across a selection, in one statement.
 *
 * Curating photos one at a time through the viewer is the reason nobody ever did
 * it. The update is scoped by org, project and the explicit file list, so a file
 * id from another project simply does not match.
 */
export async function bulkUpdatePhotoMetadata(input: unknown, orgId?: string): Promise<{ updated: number }> {
  const parsed: BulkPhotoMetadataInput = bulkPhotoMetadataSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.project_id, "docs.upload")

  const patch = {
    album_id: parsed.album_id,
    location_id: parsed.location_id,
    trade_company_id: parsed.trade_company_id,
    visibility: parsed.visibility,
  }
  const cleanPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
  if (Object.keys(cleanPatch).length === 0) return { updated: 0 }

  const { data, error } = await supabase.from("photos").update(cleanPatch)
    .eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).in("file_id", parsed.file_ids)
    .select("id, file_id")
  if (error) throw new Error(`Failed to update photos: ${error.message}`)

  const updated = data ?? []
  if (updated.length === 0) return { updated: 0 }

  await recordEvent({
    orgId: resolvedOrgId, actorId: userId,
    eventType: parsed.visibility === "client" ? "photo_published" : "photo_updated",
    entityType: "photo", entityId: updated[0].id,
    payload: { project_id: parsed.project_id, file_ids: updated.map((row) => row.file_id), count: updated.length, patch: cleanPatch },
  })
  // Audit stays one row per photo — a bulk edit is still an edit to each record —
  // but in bounded parallel rather than 200 serial round trips.
  for (let index = 0; index < updated.length; index += 25) {
    await Promise.all(updated.slice(index, index + 25).map((row) => recordAudit({
      orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "photo", entityId: row.id,
      after: { ...cleanPatch, file_id: row.file_id }, source: "photo_bulk_edit",
    })))
  }

  return { updated: updated.length }
}

/**
 * Record what the uploading client knew about the shot that the file itself
 * cannot settle: the capture instant, and the GPS fix.
 *
 * The photo record is already there — a trigger on `files` writes it, which is
 * what makes every upload path produce a listable photo whether or not it
 * remembers to call this. What only the client has is the timezone: EXIF gives a
 * wall clock with no offset, and the browser or phone that is standing in that
 * zone is the only party who can resolve it (`lib/media/exif.ts` argues this out
 * at length). Everything else about a photo — the caption, the tags, and the EXIF
 * fallback for files uploaded from somewhere that sent nothing — is filled in by
 * `enrichPhotoFromSource` on the preview job, which is the one path every image
 * takes.
 */
export async function registerUploadedPhoto(
  params: { fileId: string; projectId: string; capture?: PhotoCaptureMetadata | null },
  orgId?: string,
): Promise<void> {
  const capture = params.capture ? photoCaptureMetadataSchema.parse(params.capture) : null
  if (!capture || (!capture.taken_at && capture.latitude === undefined && capture.longitude === undefined)) return

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, params.projectId, "docs.upload")

  const patch: Record<string, unknown> = {}
  if (capture.taken_at) patch.taken_at = capture.taken_at
  if (capture.latitude !== undefined) patch.latitude = capture.latitude
  if (capture.longitude !== undefined) patch.longitude = capture.longitude

  const { error } = await supabase.from("photos").update(patch)
    .eq("org_id", resolvedOrgId).eq("project_id", params.projectId).eq("file_id", params.fileId)
  if (error) throw new Error(`Failed to record photo capture metadata: ${error.message}`)
}
