import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type {
  MobileDailyLogCommentDTO,
  MobileDailyLogContextDTO,
  MobileDailyLogDTO,
  MobileDailyLogEntryDTO,
  MobileDailyLogPhotoDTO,
} from "@/lib/mobile/contracts"
import { listProjects } from "@/lib/services/projects"
import { hasPermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { uploadFilesObject, createFilesDownloadUrl, deleteFilesObjects } from "@/lib/storage/files-storage"

const entrySchema = z.object({
  entry_type: z.enum(["work", "constraint", "inspection", "safety", "delivery", "note", "task_update", "punch_update"]),
  description: z.string().trim().max(5_000).optional(),
  quantity: z.number().nonnegative().optional(),
  hours: z.number().nonnegative().max(24).optional(),
  progress: z.number().min(0).max(100).optional(),
  schedule_item_id: z.string().uuid().optional(),
  task_id: z.string().uuid().optional(),
  punch_item_id: z.string().uuid().optional(),
  location: z.string().trim().max(500).optional(),
  trade: z.string().trim().max(250).optional(),
  inspection_result: z.enum(["pass", "fail", "partial", "n_a"]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export const mobileDailyLogInputSchema = z.object({
  client_id: z.string().uuid(),
  date: z.string().date(),
  summary: z.string().trim().max(20_000).optional(),
  weather: z.string().trim().max(500).optional(),
  entries: z.array(entrySchema).max(100).default([]),
  mentioned_user_ids: z.array(z.string().uuid()).max(100).default([]),
})

const updateSchema = z.object({
  summary: z.string().trim().max(20_000).optional(),
  weather: z.string().trim().max(500).optional(),
  mentioned_user_ids: z.array(z.string().uuid()).max(100).default([]),
})

const commentSchema = z.object({
  client_id: z.string().uuid(),
  body: z.string().trim().min(1).max(10_000),
  mentioned_user_ids: z.array(z.string().uuid()).max(100).default([]),
})

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

async function requireDailyLogPermission(context: MobileOrgContext, permission: "daily_log.read" | "daily_log.write") {
  if (context.isPlatformAdmin) return
  const allowed = await hasPermission(permission, {
    supabase: context.serviceSupabase,
    orgId: context.orgId,
    userId: context.user.id,
  })
  if (!allowed) throw new MobileAPIError(403, "daily_logs_forbidden", "You do not have access to daily logs.")
}

function weatherText(value: unknown) {
  if (typeof value === "string") return value || null
  if (!value || typeof value !== "object") return null
  const weather = value as Record<string, unknown>
  const parts = [weather.conditions, weather.temperature, weather.notes].filter((item): item is string => typeof item === "string" && item.length > 0)
  return parts.length ? parts.join(" • ") : null
}

function mapEntry(row: any): MobileDailyLogEntryDTO {
  return {
    id: row.id,
    entry_type: row.entry_type,
    description: row.description ?? null,
    quantity: row.quantity == null ? null : Number(row.quantity),
    hours: row.hours == null ? null : Number(row.hours),
    progress: row.progress == null ? null : Number(row.progress),
    schedule_item_id: row.schedule_item_id ?? null,
    task_id: row.task_id ?? null,
    punch_item_id: row.punch_item_id ?? null,
    location: row.location ?? null,
    trade: row.trade ?? null,
    inspection_result: row.inspection_result ?? null,
    metadata: row.metadata ?? {},
  }
}

function mapComment(row: any, mentionedUserIds: string[] = []): MobileDailyLogCommentDTO {
  const author = Array.isArray(row.author) ? row.author[0] : row.author
  return {
    id: row.id,
    body: row.body,
    created_at: row.created_at,
    author_name: author?.full_name ?? author?.email ?? null,
    mentioned_user_ids: mentionedUserIds,
  }
}

async function hydrateLogs(context: MobileOrgContext, rows: any[]): Promise<MobileDailyLogDTO[]> {
  if (!rows.length) return []
  const ids = rows.map((row) => row.id)
  const [entriesResult, commentsResult, mentionsResult, photosResult] = await Promise.all([
    context.serviceSupabase
      .from("daily_log_entries")
      .select("id, daily_log_id, entry_type, description, quantity, hours, progress, schedule_item_id, task_id, punch_item_id, location, trade, inspection_result, metadata")
      .eq("org_id", context.orgId)
      .in("daily_log_id", ids)
      .order("created_at", { ascending: true }),
    context.serviceSupabase
      .from("daily_log_comments")
      .select("id, daily_log_id, body, created_at, author:app_users!daily_log_comments_created_by_fkey(full_name, email)")
      .eq("org_id", context.orgId)
      .in("daily_log_id", ids)
      .order("created_at", { ascending: true }),
    context.serviceSupabase
      .from("daily_log_mentions")
      .select("daily_log_id, daily_log_comment_id, mentioned_user_id")
      .eq("org_id", context.orgId)
      .in("daily_log_id", ids),
    context.serviceSupabase
      .from("files")
      .select("id, daily_log_id, file_name, mime_type, storage_path")
      .eq("org_id", context.orgId)
      .in("daily_log_id", ids),
  ])
  if (entriesResult.error || commentsResult.error || mentionsResult.error || photosResult.error) {
    throw new MobileAPIError(500, "daily_logs_unavailable", "Daily log details could not be loaded.")
  }

  const entries = new Map<string, MobileDailyLogEntryDTO[]>()
  for (const row of entriesResult.data ?? []) {
    entries.set(row.daily_log_id, [...(entries.get(row.daily_log_id) ?? []), mapEntry(row)])
  }
  const comments = new Map<string, MobileDailyLogCommentDTO[]>()
  const logMentions = new Map<string, string[]>()
  const commentMentions = new Map<string, string[]>()
  for (const row of mentionsResult.data ?? []) {
    const target = row.daily_log_comment_id ? commentMentions : logMentions
    const key = row.daily_log_comment_id ?? row.daily_log_id
    target.set(key, [...(target.get(key) ?? []), row.mentioned_user_id])
  }
  for (const row of commentsResult.data ?? []) {
    comments.set(row.daily_log_id, [...(comments.get(row.daily_log_id) ?? []), mapComment(row, commentMentions.get(row.id) ?? [])])
  }
  const photos = new Map<string, MobileDailyLogPhotoDTO[]>()
  for (const row of photosResult.data ?? []) {
    if (!row.daily_log_id) continue
    try {
      const signed = await createFilesDownloadUrl({
        supabase: context.serviceSupabase,
        orgId: context.orgId,
        path: row.storage_path,
        fileName: row.file_name,
        expiresIn: 3_600,
      })
      const photo = {
        id: row.id,
        file_name: row.file_name,
        mime_type: row.mime_type ?? null,
        download_url: signed.downloadUrl,
      }
      photos.set(row.daily_log_id, [...(photos.get(row.daily_log_id) ?? []), photo])
    } catch (error) {
      console.error("Mobile daily log photo URL failed", { fileId: row.id, error })
    }
  }

  return rows.map((row) => ({
    id: row.id,
    organization_id: row.org_id,
    project_id: row.project_id,
    date: row.log_date,
    summary: row.summary ?? null,
    weather: weatherText(row.weather),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    entries: entries.get(row.id) ?? [],
    comments: comments.get(row.id) ?? [],
    mentioned_user_ids: logMentions.get(row.id) ?? [],
    photos: photos.get(row.id) ?? [],
    photo_count: photos.get(row.id)?.length ?? 0,
  }))
}

export async function listMobileDailyLogs(context: MobileOrgContext, projectId: string) {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.read")
  const { data, error } = await context.serviceSupabase
    .from("daily_logs")
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("log_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(100)
  if (error) throw new MobileAPIError(500, "daily_logs_unavailable", "Daily logs could not be loaded.")
  return hydrateLogs(context, data ?? [])
}

export async function getMobileDailyLogContext(
  context: MobileOrgContext,
  projectId: string,
): Promise<MobileDailyLogContextDTO> {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.read")
  const [schedule, tasks, punch, team] = await Promise.all([
    context.serviceSupabase
      .from("schedule_items")
      .select("id, name, status, progress, trade, location")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true }),
    context.serviceSupabase
      .from("tasks")
      .select("id, title, status")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .neq("status", "done")
      .order("created_at", { ascending: false }),
    context.serviceSupabase
      .from("punch_items")
      .select("id, title, status, location")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .neq("status", "closed")
      .order("created_at", { ascending: false }),
    context.serviceSupabase
      .from("project_members")
      .select("user_id, role:roles(label), user:app_users(full_name, email)")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .eq("status", "active"),
  ])
  if (schedule.error || tasks.error || punch.error || team.error) {
    throw new MobileAPIError(500, "daily_log_context_unavailable", "Daily log options could not be loaded.")
  }
  return {
    schedule_items: (schedule.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status ?? "planned",
      progress: Number(row.progress ?? 0),
      trade: row.trade ?? null,
      location: row.location ?? null,
    })),
    tasks: (tasks.data ?? []).map((row) => ({ id: row.id, title: row.title, status: row.status })),
    punch_items: (punch.data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      location: row.location ?? null,
    })),
    team: (team.data ?? []).map((row: any) => ({
      id: row.user_id,
      name: row.user?.full_name ?? row.user?.email ?? "Team member",
      email: row.user?.email ?? null,
      role: row.role?.label ?? null,
    })),
  }
}

async function syncMentions({
  context,
  projectId,
  dailyLogId,
  commentId,
  userIds,
  body,
  replace,
  notify = true,
}: {
  context: MobileOrgContext
  projectId: string
  dailyLogId: string
  commentId?: string
  userIds: string[]
  body: string
  replace?: boolean
  notify?: boolean
}) {
  if (replace) {
    let deletion = context.serviceSupabase
      .from("daily_log_mentions")
      .delete()
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .eq("daily_log_id", dailyLogId)
    deletion = commentId ? deletion.eq("daily_log_comment_id", commentId) : deletion.is("daily_log_comment_id", null)
    const { error } = await deletion
    if (error) throw new MobileAPIError(500, "daily_log_mentions_failed", "Mentions could not be updated.")
  }
  const uniqueIds = [...new Set(userIds)].filter((id) => id !== context.user.id)
  if (!uniqueIds.length) return
  const { data: members, error: memberError } = await context.serviceSupabase
    .from("project_members")
    .select("user_id")
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("status", "active")
    .in("user_id", uniqueIds)
  if (memberError) throw new MobileAPIError(500, "daily_log_mentions_failed", "Mentions could not be validated.")
  const validIds = (members ?? []).map((member) => member.user_id)
  if (!validIds.length) return
  const { error } = await context.serviceSupabase.from("daily_log_mentions").insert(
    validIds.map((id) => ({
      org_id: context.orgId,
      project_id: projectId,
      daily_log_id: dailyLogId,
      daily_log_comment_id: commentId ?? null,
      mentioned_user_id: id,
      mentioned_by: context.user.id,
    })),
  )
  if (error) throw new MobileAPIError(500, "daily_log_mentions_failed", "Mentions could not be saved.")

  if (!notify) return
  const actor = context.user.user_metadata?.full_name ?? context.user.email ?? "A teammate"
  const notifications = new NotificationService()
  await Promise.all(validIds.map((id) => notifications.createAndQueue({
    orgId: context.orgId,
    userId: id,
    type: "daily_log_mentioned",
    title: "You were mentioned in a daily log",
    message: `${actor} mentioned you${body ? `: ${body.slice(0, 180)}` : "."}`,
    projectId,
    entityType: "daily_log",
    entityId: dailyLogId,
    metadata: { daily_log_id: dailyLogId, daily_log_comment_id: commentId },
  })))
}

async function applyLinkedUpdates(
  context: MobileOrgContext,
  projectId: string,
  dailyLogId: string,
  entries: z.infer<typeof entrySchema>[],
) {
  for (const entry of entries) {
    if (entry.schedule_item_id && (entry.hours != null || entry.progress != null || entry.inspection_result)) {
      const { data: item } = await context.serviceSupabase
        .from("schedule_items")
        .select("actual_hours, status")
        .eq("org_id", context.orgId)
        .eq("project_id", projectId)
        .eq("id", entry.schedule_item_id)
        .maybeSingle()
      const update: Record<string, unknown> = {}
      if (entry.hours != null) update.actual_hours = Number(item?.actual_hours ?? 0) + entry.hours
      if (entry.progress != null) {
        update.progress = entry.progress
        update.status = entry.progress >= 100 ? "completed" : entry.progress > 0 ? "in_progress" : item?.status
      }
      if (entry.inspection_result) {
        update.inspection_result = entry.inspection_result
        update.inspected_at = new Date().toISOString()
        update.inspected_by = context.user.id
      }
      await context.serviceSupabase.from("schedule_items").update(update)
        .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", entry.schedule_item_id)
    }
    if (entry.entry_type === "task_update" && entry.task_id && entry.metadata?.mark_complete) {
      await context.serviceSupabase.from("tasks").update({
        status: "done",
        completed_at: new Date().toISOString(),
        metadata: { ...entry.metadata, linked_daily_log_id: dailyLogId },
      }).eq("org_id", context.orgId).eq("project_id", projectId).eq("id", entry.task_id)
    }
    if (entry.entry_type === "punch_update" && entry.punch_item_id && entry.metadata?.mark_closed) {
      await context.serviceSupabase.from("punch_items").update({
        status: "closed",
        resolved_at: new Date().toISOString(),
        resolved_by: context.user.id,
      }).eq("org_id", context.orgId).eq("project_id", projectId).eq("id", entry.punch_item_id)
    }
  }
}

export async function createMobileDailyLog(context: MobileOrgContext, projectId: string, input: unknown) {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.write")
  const parsed = mobileDailyLogInputSchema.safeParse(input)
  if (!parsed.success) {
    throw new MobileAPIError(422, "invalid_daily_log", "Some daily log information is invalid.", {
      fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
    })
  }

  const existing = await context.serviceSupabase
    .from("daily_logs")
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .eq("id", parsed.data.client_id)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .maybeSingle()
  if (existing.error) throw new MobileAPIError(500, "daily_log_create_failed", "The daily log could not be saved.")
  if (existing.data) {
    await syncMentions({
      context,
      projectId,
      dailyLogId: existing.data.id,
      userIds: parsed.data.mentioned_user_ids,
      body: parsed.data.summary ?? "",
      replace: true,
      notify: false,
    })
    const hydrated = (await hydrateLogs(context, [existing.data]))[0]
    if (!hydrated) throw new MobileAPIError(500, "daily_log_unavailable", "The daily log could not be loaded.")
    return hydrated
  }

  const { data, error } = await context.serviceSupabase
    .from("daily_logs")
    .insert({
      id: parsed.data.client_id,
      org_id: context.orgId,
      project_id: projectId,
      log_date: parsed.data.date,
      summary: parsed.data.summary || null,
      weather: parsed.data.weather || null,
      created_by: context.user.id,
    })
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .single()
  if (error || !data) throw new MobileAPIError(500, "daily_log_create_failed", "The daily log could not be saved.")

  if (parsed.data.entries.length) {
    const { error: entryError } = await context.serviceSupabase.from("daily_log_entries").insert(
      parsed.data.entries.map((entry) => ({
        org_id: context.orgId,
        project_id: projectId,
        daily_log_id: data.id,
        entry_type: entry.entry_type,
        description: entry.description || null,
        quantity: entry.quantity ?? null,
        hours: entry.hours ?? null,
        progress: entry.progress ?? null,
        schedule_item_id: entry.schedule_item_id ?? null,
        task_id: entry.task_id ?? null,
        punch_item_id: entry.punch_item_id ?? null,
        location: entry.location || null,
        trade: entry.trade || null,
        inspection_result: entry.inspection_result ?? null,
        metadata: entry.metadata ?? {},
      })),
    )
    if (entryError) {
      await context.serviceSupabase.from("daily_logs").delete().eq("id", data.id).eq("org_id", context.orgId)
      throw new MobileAPIError(500, "daily_log_entries_failed", "Daily log entries could not be saved.")
    }
    await applyLinkedUpdates(context, projectId, data.id, parsed.data.entries)
  }

  await syncMentions({
    context,
    projectId,
    dailyLogId: data.id,
    userIds: parsed.data.mentioned_user_ids,
    body: parsed.data.summary ?? "",
  })

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: "daily_log_created",
      entityType: "daily_log",
      entityId: data.id,
      payload: { project_id: projectId, summary: parsed.data.summary },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.user.id,
      action: "insert",
      entityType: "daily_log",
      entityId: data.id,
      after: data,
    }),
  ])
  const hydrated = (await hydrateLogs(context, [data]))[0]
  if (!hydrated) throw new MobileAPIError(500, "daily_log_unavailable", "The daily log could not be loaded.")
  return hydrated
}

export async function updateMobileDailyLog(
  context: MobileOrgContext,
  projectId: string,
  dailyLogId: string,
  input: unknown,
) {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.write")
  const parsed = updateSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_daily_log", "Some daily log information is invalid.")
  const { data, error } = await context.serviceSupabase.from("daily_logs").update({
    summary: parsed.data.summary || null,
    weather: parsed.data.weather || null,
  }).eq("org_id", context.orgId).eq("project_id", projectId).eq("id", dailyLogId)
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at").maybeSingle()
  if (error) throw new MobileAPIError(500, "daily_log_update_failed", "The daily log could not be updated.")
  if (!data) throw new MobileAPIError(404, "daily_log_not_found", "Daily log not found.")
  await syncMentions({
    context,
    projectId,
    dailyLogId,
    userIds: parsed.data.mentioned_user_ids,
    body: parsed.data.summary ?? "",
    replace: true,
  })
  const hydrated = (await hydrateLogs(context, [data]))[0]
  if (!hydrated) throw new MobileAPIError(500, "daily_log_unavailable", "The daily log could not be loaded.")
  return hydrated
}

export async function deleteMobileDailyLog(context: MobileOrgContext, projectId: string, dailyLogId: string) {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.write")
  const { data, error } = await context.serviceSupabase.from("daily_logs").delete()
    .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", dailyLogId).select("id").maybeSingle()
  if (error) throw new MobileAPIError(500, "daily_log_delete_failed", "The daily log could not be deleted.")
  if (!data) return
  await recordEvent({
    orgId: context.orgId,
    eventType: "daily_log_deleted",
    entityType: "daily_log",
    entityId: dailyLogId,
    payload: { project_id: projectId },
  })
}

export async function createMobileDailyLogComment(
  context: MobileOrgContext,
  projectId: string,
  dailyLogId: string,
  input: unknown,
) {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.write")
  const parsed = commentSchema.safeParse(input)
  if (!parsed.success) throw new MobileAPIError(422, "invalid_comment", "A comment is required.")
  const { data: log } = await context.serviceSupabase.from("daily_logs").select("id")
    .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", dailyLogId).maybeSingle()
  if (!log) throw new MobileAPIError(404, "daily_log_not_found", "Daily log not found.")
  const existing = await context.serviceSupabase.from("daily_log_comments")
    .select("id, daily_log_id, body, created_at, author:app_users!daily_log_comments_created_by_fkey(full_name, email)")
    .eq("org_id", context.orgId).eq("id", parsed.data.client_id).maybeSingle()
  if (existing.data) return mapComment(existing.data, parsed.data.mentioned_user_ids)
  const { data, error } = await context.serviceSupabase.from("daily_log_comments").insert({
    id: parsed.data.client_id,
    org_id: context.orgId,
    project_id: projectId,
    daily_log_id: dailyLogId,
    body: parsed.data.body,
    created_by: context.user.id,
  }).select("id, daily_log_id, body, created_at, author:app_users!daily_log_comments_created_by_fkey(full_name, email)").single()
  if (error || !data) throw new MobileAPIError(500, "comment_create_failed", "The comment could not be saved.")
  await syncMentions({
    context,
    projectId,
    dailyLogId,
    commentId: data.id,
    userIds: parsed.data.mentioned_user_ids,
    body: parsed.data.body,
  })
  return mapComment(data, parsed.data.mentioned_user_ids)
}

export async function uploadMobileDailyLogPhoto(
  context: MobileOrgContext,
  projectId: string,
  dailyLogId: string,
  formData: FormData,
): Promise<MobileDailyLogPhotoDTO> {
  await requireProject(context, projectId)
  await requireDailyLogPermission(context, "daily_log.write")
  const clientId = z.string().uuid().safeParse(formData.get("client_id"))
  const file = formData.get("file")
  if (!clientId.success || !(file instanceof File) || !file.type.startsWith("image/")) {
    throw new MobileAPIError(422, "invalid_photo", "Select a valid image.")
  }
  if (file.size > 20 * 1024 * 1024) throw new MobileAPIError(422, "photo_too_large", "Photos must be under 20 MB.")
  const { data: log } = await context.serviceSupabase.from("daily_logs").select("id")
    .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", dailyLogId).maybeSingle()
  if (!log) throw new MobileAPIError(409, "daily_log_pending", "The daily log must sync before its photos.")

  const existing = await context.serviceSupabase.from("files")
    .select("id, file_name, mime_type, storage_path")
    .eq("org_id", context.orgId).eq("id", clientId.data).maybeSingle()
  if (existing.data) return signedPhoto(context, existing.data)

  const safeName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_") || `${clientId.data}.jpg`
  const storagePath = `${context.orgId}/${projectId}/daily-logs/uploads/${clientId.data}_${safeName}`
  await uploadFilesObject({
    supabase: context.serviceSupabase,
    orgId: context.orgId,
    path: storagePath,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    upsert: true,
  })
  const { data, error } = await context.serviceSupabase.from("files").insert({
    id: clientId.data,
    org_id: context.orgId,
    project_id: projectId,
    daily_log_id: dailyLogId,
    file_name: safeName,
    storage_path: storagePath,
    mime_type: file.type,
    size_bytes: file.size,
    visibility: "private",
    uploaded_by: context.user.id,
    category: "photos",
    folder_path: "/daily-logs",
    tags: [],
  }).select("id, file_name, mime_type, storage_path").single()
  if (error || !data) {
    await deleteFilesObjects({ supabase: context.serviceSupabase, orgId: context.orgId, paths: [storagePath] })
    throw new MobileAPIError(500, "photo_upload_failed", "The photo could not be saved.")
  }
  const { data: version } = await context.serviceSupabase.from("doc_versions").insert({
    org_id: context.orgId,
    file_id: data.id,
    version_number: 1,
    storage_path: storagePath,
    file_name: safeName,
    mime_type: file.type,
    size_bytes: file.size,
    created_by: context.user.id,
  }).select("id").single()
  if (version?.id) await context.serviceSupabase.from("files").update({ current_version_id: version.id }).eq("id", data.id)
  return signedPhoto(context, data)
}

async function signedPhoto(context: MobileOrgContext, row: any): Promise<MobileDailyLogPhotoDTO> {
  const signed = await createFilesDownloadUrl({
    supabase: context.serviceSupabase,
    orgId: context.orgId,
    path: row.storage_path,
    fileName: row.file_name,
    expiresIn: 3_600,
  })
  return { id: row.id, file_name: row.file_name, mime_type: row.mime_type ?? null, download_url: signed.downloadUrl }
}
