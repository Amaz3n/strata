import "server-only"

import { listFileSourceContexts } from "@/lib/services/file-source-contexts"
import { buildInternalFileUrl, type FileSourceContext } from "@/lib/services/files"
import { requireOrgContext } from "@/lib/services/context"
import { createDailyLog } from "@/lib/services/daily-logs"
import { requireProjectPermission } from "@/lib/services/permissions"
import { createFilesDownloadUrl } from "@/lib/storage/files-storage"
import { ensurePhotoDailyLogSchema, listProjectPhotosSchema, type ListProjectPhotosInput, type ProjectPhotoFilters } from "@/lib/validation/photos"

const SCAN_BATCH_SIZE = 96

type PhotoFileRow = {
  id: string
  org_id: string
  project_id: string
  daily_log_id: string | null
  file_name: string
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  uploaded_by: string | null
  created_at: string
  app_users: { full_name: string | null; avatar_url: string | null } | Array<{ full_name: string | null; avatar_url: string | null }> | null
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
  file_name: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
  uploaded_by: string | null
  uploader_name: string | null
  uploader_avatar: string | null
  thumbnail_url: string
  image_url: string
  sources: ProjectPhotoSource[]
  primary_source: ProjectPhotoSource
  location_ids: string[]
  locations: string[]
}

export type ProjectPhotoPage = {
  photos: ProjectPhoto[]
  next_cursor: string | null
}

export type ProjectPhotoUploader = { id: string; name: string }

type Cursor = { createdAt: string; id: string }

function encodeCursor(cursor: Cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (!parsed || typeof parsed !== "object") throw new Error("Invalid cursor")
    const cursor = parsed as Record<string, unknown>
    if (typeof cursor.createdAt !== "string" || typeof cursor.id !== "string") throw new Error("Invalid cursor")
    if (Number.isNaN(Date.parse(cursor.createdAt))) throw new Error("Invalid cursor")
    return { createdAt: cursor.createdAt, id: cursor.id }
  } catch {
    throw new Error("Invalid photo cursor")
  }
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
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

async function hydratePhotoRows(
  rows: PhotoFileRow[],
  projectId: string,
  orgId: string,
): Promise<ProjectPhoto[]> {
  if (rows.length === 0) return []
  const { supabase } = await requireOrgContext(orgId)
  const fileIds = rows.map((row) => row.id)
  const directDailyLogIds = rows.map((row) => row.daily_log_id).filter((id): id is string => Boolean(id))

  const [contextsByFileId, linksResult, legacyPhotosResult, inspectionItemsResult, observationsResult, incidentsResult] = await Promise.all([
    listFileSourceContexts(fileIds, orgId),
    supabase.from("file_links").select("file_id, entity_type, entity_id").eq("org_id", orgId).eq("project_id", projectId).in("file_id", fileIds),
    supabase.from("photos").select("file_id, daily_log_id, task_id, taken_at").eq("org_id", orgId).eq("project_id", projectId).in("file_id", fileIds),
    supabase.from("inspection_items").select("id, photo_file_id, inspection:inspections(id, project_id, inspection_number, title, inspected_at, location_id, location)").eq("org_id", orgId).in("photo_file_id", fileIds),
    supabase.from("observations").select("id, photo_file_id, observation_number, kind, created_at, location_id, location").eq("org_id", orgId).eq("project_id", projectId).in("photo_file_id", fileIds),
    supabase.from("safety_incidents").select("id, photo_file_id, incident_number, occurred_at, location_id, location").eq("org_id", orgId).eq("project_id", projectId).in("photo_file_id", fileIds),
  ])

  for (const result of [linksResult, legacyPhotosResult, inspectionItemsResult, observationsResult, incidentsResult]) {
    if (result.error) throw new Error(`Failed to load photo sources: ${result.error.message}`)
  }

  const links = linksResult.data ?? []
  const punchIds = links.filter((link) => link.entity_type === "punch_item").map((link) => link.entity_id)
  const rfiIds = links.filter((link) => link.entity_type === "rfi").map((link) => link.entity_id)
  const linkedDailyLogIds = links.filter((link) => link.entity_type === "daily_log").map((link) => link.entity_id)
  const legacyDailyLogIds = (legacyPhotosResult.data ?? []).map((photo) => photo.daily_log_id).filter((id): id is string => Boolean(id))
  const legacyTaskIds = (legacyPhotosResult.data ?? []).map((photo) => photo.task_id).filter((id): id is string => Boolean(id))
  const dailyLogIds = Array.from(new Set([...directDailyLogIds, ...linkedDailyLogIds, ...legacyDailyLogIds]))

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
    legacyTaskIds.length
      ? supabase.from("tasks").select("id, title, created_at, metadata").eq("org_id", orgId).eq("project_id", projectId).in("id", legacyTaskIds)
      : Promise.resolve({ data: [], error: null }),
  ])

  for (const result of [dailyLogsResult, punchResult, rfisResult, tasksResult]) {
    if (result.error) throw new Error(`Failed to hydrate photo source details: ${result.error.message}`)
  }

  const sources = new Map<string, ProjectPhotoSource[]>()
  const fileIdsByDailyLog = new Map<string, string[]>()
  for (const row of rows) {
    if (row.daily_log_id) fileIdsByDailyLog.set(row.daily_log_id, [...(fileIdsByDailyLog.get(row.daily_log_id) ?? []), row.id])
  }
  for (const link of links) {
    if (link.entity_type === "daily_log") fileIdsByDailyLog.set(link.entity_id, [...(fileIdsByDailyLog.get(link.entity_id) ?? []), link.file_id])
  }
  for (const photo of legacyPhotosResult.data ?? []) {
    if (photo.daily_log_id) fileIdsByDailyLog.set(photo.daily_log_id, [...(fileIdsByDailyLog.get(photo.daily_log_id) ?? []), photo.file_id])
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
  const legacyFilesByTask = new Map<string, string[]>()
  for (const photo of legacyPhotosResult.data ?? []) {
    if (photo.task_id) legacyFilesByTask.set(photo.task_id, [...(legacyFilesByTask.get(photo.task_id) ?? []), photo.file_id])
  }
  for (const task of tasksResult.data ?? []) {
    const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata as Record<string, unknown> : {}
    const location = typeof metadata.location === "string" ? metadata.location : null
    for (const fileId of legacyFilesByTask.get(task.id) ?? []) addSource(sources, fileId, {
      type: "task", entity_id: task.id, label: `Task · ${task.title}`, href: `/projects/${projectId}/tasks?task=${task.id}`,
      location_id: null, location, source_date: task.created_at,
    })
  }
  for (const item of inspectionItemsResult.data ?? []) {
    const inspection = relationOne(item.inspection)
    if (!inspection || inspection.project_id !== projectId) continue
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
    for (const context of contextsByFileId[row.id] ?? []) addSource(sources, row.id, contextToSource(projectId, context))
  }

  return Promise.all(rows.map(async (row) => {
    const rowSources = sources.get(row.id) ?? []
    const effectiveSources = rowSources.length ? rowSources : [fallbackSource(projectId, row.id)]
    const uploader = relationOne(row.app_users)
    const signed = await createFilesDownloadUrl({ supabase, orgId, path: row.storage_path, fileName: row.file_name, expiresIn: 3_600 })
      .then((result) => result.downloadUrl)
      .catch(() => buildInternalFileUrl(row.id))
    const isHeic = row.mime_type === "image/heic" || row.mime_type === "image/heif" || /\.hei[cf]$/i.test(row.file_name)
    const locationIds = Array.from(new Set(effectiveSources.map((source) => source.location_id).filter((id): id is string => Boolean(id))))
    const locations = Array.from(new Set(effectiveSources.map((source) => source.location).filter((value): value is string => Boolean(value))))
    return {
      id: row.id,
      file_name: row.file_name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      created_at: row.created_at,
      uploaded_by: row.uploaded_by,
      uploader_name: uploader?.full_name ?? null,
      uploader_avatar: uploader?.avatar_url ?? null,
      thumbnail_url: isHeic ? `/api/files/${row.id}/preview` : signed,
      image_url: isHeic ? `/api/files/${row.id}/preview` : signed,
      sources: effectiveSources,
      primary_source: effectiveSources[0],
      location_ids: locationIds,
      locations,
    }
  }))
}

function matchesFilters(photo: ProjectPhoto, filters: ProjectPhotoFilters) {
  if (filters.source_type === "files" && photo.sources.some((source) => source.type !== "files")) return false
  if (filters.source_type && filters.source_type !== "files" && !photo.sources.some((source) => source.type === filters.source_type)) return false
  if (filters.location_id && !photo.location_ids.includes(filters.location_id)) return false
  return true
}

export async function listProjectPhotos(input: ListProjectPhotosInput, orgId?: string): Promise<ProjectPhotoPage> {
  const parsed = listProjectPhotosSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, parsed.projectId, "docs.read")
  let cursor = decodeCursor(parsed.cursor)
  const photos: ProjectPhoto[] = []

  while (photos.length < parsed.limit) {
    let query = supabase.from("files").select("id, org_id, project_id, daily_log_id, file_name, storage_path, mime_type, size_bytes, uploaded_by, created_at, app_users!files_uploaded_by_fkey(full_name, avatar_url)")
      .eq("org_id", resolvedOrgId).eq("project_id", parsed.projectId).is("archived_at", null).like("mime_type", "image/%")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(SCAN_BATCH_SIZE)
    if (parsed.filters.date_from) query = query.gte("created_at", `${parsed.filters.date_from}T00:00:00.000Z`)
    if (parsed.filters.date_to) {
      const exclusiveEnd = new Date(`${parsed.filters.date_to}T00:00:00.000Z`)
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1)
      query = query.lt("created_at", exclusiveEnd.toISOString())
    }
    if (parsed.filters.uploader_id) query = query.eq("uploaded_by", parsed.filters.uploader_id)
    if (cursor) query = query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`)

    const { data, error } = await query
    if (error) throw new Error(`Failed to load project photos: ${error.message}`)
    const rows = (data ?? []) as PhotoFileRow[]
    if (rows.length === 0) return { photos, next_cursor: null }
    const hydrated = await hydratePhotoRows(rows, parsed.projectId, resolvedOrgId)
    for (const photo of hydrated) {
      cursor = { createdAt: photo.created_at, id: photo.id }
      if (matchesFilters(photo, parsed.filters)) photos.push(photo)
      if (photos.length === parsed.limit) return { photos, next_cursor: encodeCursor(cursor) }
    }
    if (rows.length < SCAN_BATCH_SIZE) return { photos, next_cursor: null }
  }
  return { photos, next_cursor: cursor ? encodeCursor(cursor) : null }
}

export async function listProjectPhotoUploaders(projectId: string, orgId?: string): Promise<ProjectPhotoUploader[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireProjectPermission(userId, projectId, "docs.read")
  const { data, error } = await supabase.from("files").select("uploaded_by, app_users!files_uploaded_by_fkey(full_name)")
    .eq("org_id", resolvedOrgId).eq("project_id", projectId).is("archived_at", null).like("mime_type", "image/%").not("uploaded_by", "is", null).limit(2000)
  if (error) throw new Error(`Failed to load photo uploaders: ${error.message}`)
  const uploaders = new Map<string, string>()
  for (const row of data ?? []) {
    if (!row.uploaded_by) continue
    const user = relationOne(row.app_users)
    uploaders.set(row.uploaded_by, user?.full_name?.trim() || "Unknown user")
  }
  return Array.from(uploaders, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
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
