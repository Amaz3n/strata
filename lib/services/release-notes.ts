import type { SupabaseClient } from "@supabase/supabase-js"

import { requireOrgMembership } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export type ReleaseNoteCategory = "new" | "improved" | "fixed" | "admin" | "mobile"
export type ReleaseNoteVisibility = "quiet" | "badge" | "announce"

export interface ReleaseNote {
  id: string
  slug: string
  title: string
  summary: string
  body: string | null
  category: ReleaseNoteCategory
  visibility: ReleaseNoteVisibility
  href: string | null
  ctaLabel: string | null
  publishedAt: string
  seenAt: string | null
  announcedAt: string | null
  dismissedAt: string | null
}

export interface ReleaseNotesOverview {
  notes: ReleaseNote[]
  unreadCount: number
  announcement: ReleaseNote | null
}

export interface AdminReleaseNote extends ReleaseNote {
  orgId: string | null
  audienceRoles: string[]
  audiencePermissions: string[]
  audienceFeatures: string[]
  isPublished: boolean
  expiresAt: string | null
  createdAt: string
}

export type ReleaseNoteInput = {
  slug: string
  title: string
  summary: string
  body?: string | null
  category: ReleaseNoteCategory
  visibility: ReleaseNoteVisibility
  href?: string | null
  ctaLabel?: string | null
  orgId?: string | null
  audienceRoles?: string[]
  audiencePermissions?: string[]
  audienceFeatures?: string[]
  isPublished: boolean
  publishedAt?: string | null
  expiresAt?: string | null
}

type ReleaseNoteRow = {
  id: string
  slug: string
  title: string
  summary: string
  body: string | null
  category: ReleaseNoteCategory
  visibility: ReleaseNoteVisibility
  href: string | null
  cta_label: string | null
  org_id: string | null
  audience_roles: string[] | null
  audience_permissions: string[] | null
  audience_features: string[] | null
  published_at: string | null
  expires_at: string | null
  is_published?: boolean
  created_at?: string
}

type ReleaseNoteViewRow = {
  release_note_id: string
  seen_at: string | null
  announced_at: string | null
  dismissed_at: string | null
}

function mapAdminReleaseNote(row: ReleaseNoteRow): AdminReleaseNote {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    category: row.category,
    visibility: row.visibility,
    href: row.href,
    ctaLabel: row.cta_label,
    publishedAt: row.published_at ?? "",
    seenAt: null,
    announcedAt: null,
    dismissedAt: null,
    orgId: row.org_id,
    audienceRoles: row.audience_roles ?? [],
    audiencePermissions: row.audience_permissions ?? [],
    audienceFeatures: row.audience_features ?? [],
    isPublished: Boolean(row.is_published),
    expiresAt: row.expires_at,
    createdAt: row.created_at ?? row.published_at ?? "",
  }
}

type ReleaseNotesContext = {
  supabase: SupabaseClient
  orgId: string
  userId: string
  roleKey?: string | null
  permissions: string[]
  featureKeys: string[]
}

function intersects(required: string[] | null | undefined, available: Set<string>) {
  if (!required || required.length === 0) return true
  if (available.has("*")) return true
  return required.some((item) => available.has(item))
}

function canSeeReleaseNote(note: ReleaseNoteRow, context: ReleaseNotesContext) {
  if (note.org_id && note.org_id !== context.orgId) return false

  if (note.expires_at) {
    const expiresAt = new Date(note.expires_at).getTime()
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) return false
  }

  const roles = note.audience_roles ?? []
  if (roles.length > 0 && (!context.roleKey || !roles.includes(context.roleKey))) return false

  const permissions = new Set(context.permissions)
  if (!intersects(note.audience_permissions, permissions)) return false

  const features = new Set(context.featureKeys)
  if (!intersects(note.audience_features, features)) return false

  return true
}

async function getEnabledFeatureKeys(supabase: SupabaseClient, orgId: string) {
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from("feature_flags")
    .select("flag_key")
    .eq("org_id", orgId)
    .eq("enabled", true)
    .or(`expires_at.is.null,expires_at.gt.${now}`)

  if (error) {
    console.error("Unable to load release-note feature targets", error)
    return []
  }

  return (data ?? []).map((flag) => flag.flag_key as string).filter(Boolean)
}

function mapReleaseNote(row: ReleaseNoteRow, view?: ReleaseNoteViewRow): ReleaseNote | null {
  if (!row.published_at) return null

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    category: row.category,
    visibility: row.visibility,
    href: row.href,
    ctaLabel: row.cta_label,
    publishedAt: row.published_at,
    seenAt: view?.seen_at ?? null,
    announcedAt: view?.announced_at ?? null,
    dismissedAt: view?.dismissed_at ?? null,
  }
}

async function getReleaseNotesContext(): Promise<ReleaseNotesContext> {
  const [{ orgId, user, membership }, permissionResult] = await Promise.all([
    requireOrgMembership(),
    getCurrentUserPermissions(),
  ])
  const supabase = createServiceSupabaseClient()

  return {
    supabase,
    orgId,
    userId: user.id,
    roleKey: membership.role_key,
    permissions: permissionResult.permissions,
    featureKeys: await getEnabledFeatureKeys(supabase, orgId),
  }
}

async function fetchVisibleReleaseNotes(context: ReleaseNotesContext, limit = 50) {
  const now = new Date().toISOString()
  const { data, error } = await context.supabase
    .from("release_notes")
    .select(
      "id, slug, title, summary, body, category, visibility, href, cta_label, org_id, audience_roles, audience_permissions, audience_features, published_at, expires_at",
    )
    .eq("is_published", true)
    .lte("published_at", now)
    .or(`org_id.is.null,org_id.eq.${context.orgId}`)
    .order("published_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("Unable to load release notes", error)
    return []
  }

  return ((data ?? []) as ReleaseNoteRow[]).filter((note) => canSeeReleaseNote(note, context))
}

async function fetchViews(context: ReleaseNotesContext, releaseNoteIds: string[]) {
  if (releaseNoteIds.length === 0) return new Map<string, ReleaseNoteViewRow>()

  const { data, error } = await context.supabase
    .from("release_note_views")
    .select("release_note_id, seen_at, announced_at, dismissed_at")
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .in("release_note_id", releaseNoteIds)

  if (error) {
    console.error("Unable to load release note views", error)
    return new Map<string, ReleaseNoteViewRow>()
  }

  return new Map((data ?? []).map((view) => [view.release_note_id, view as ReleaseNoteViewRow]))
}

export async function getReleaseNotesOverview(limit = 50): Promise<ReleaseNotesOverview> {
  const context = await getReleaseNotesContext()
  const rows = await fetchVisibleReleaseNotes(context, limit)
  const views = await fetchViews(context, rows.map((note) => note.id))
  const notes = rows
    .map((row) => mapReleaseNote(row, views.get(row.id)))
    .filter((note): note is ReleaseNote => Boolean(note))

  const unreadCount = notes.filter((note) => note.visibility !== "quiet" && !note.seenAt).length
  const announcement =
    notes.find(
      (note) =>
        note.visibility === "announce" &&
        !note.announcedAt &&
        !note.dismissedAt,
    ) ?? null

  return { notes, unreadCount, announcement }
}

export async function getReleaseNotesSummary() {
  const overview = await getReleaseNotesOverview(20)
  return {
    unreadCount: overview.unreadCount,
    announcement: overview.announcement,
  }
}

async function upsertReleaseNoteViews(
  releaseNoteIds: string[],
  values: { seen_at?: string; announced_at?: string; dismissed_at?: string },
) {
  if (releaseNoteIds.length === 0) return

  const { orgId, user } = await requireOrgMembership()
  const service = createServiceSupabaseClient()
  const now = new Date().toISOString()

  const rows = releaseNoteIds.map((releaseNoteId) => ({
    release_note_id: releaseNoteId,
    org_id: orgId,
    user_id: user.id,
    ...values,
    updated_at: now,
  }))

  const { error } = await service
    .from("release_note_views")
    .upsert(rows, {
      onConflict: "release_note_id,org_id,user_id",
      ignoreDuplicates: true,
    })

  if (error) {
    console.error("Unable to update release note views", error)
    throw new Error(`Unable to update release notes: ${error.message}`)
  }

  const { error: updateError } = await service
    .from("release_note_views")
    .update({ ...values, updated_at: now })
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .in("release_note_id", releaseNoteIds)

  if (updateError) {
    console.error("Unable to update release note view timestamps", updateError)
    throw new Error(`Unable to update release notes: ${updateError.message}`)
  }
}

export async function markReleaseNotesSeen(releaseNoteIds: string[]) {
  const now = new Date().toISOString()
  await upsertReleaseNoteViews(releaseNoteIds, { seen_at: now })
}

export async function markReleaseNoteAnnounced(releaseNoteId: string) {
  const now = new Date().toISOString()
  await upsertReleaseNoteViews([releaseNoteId], { announced_at: now })
}

export async function dismissReleaseNoteAnnouncement(releaseNoteId: string) {
  const now = new Date().toISOString()
  await upsertReleaseNoteViews([releaseNoteId], {
    announced_at: now,
    dismissed_at: now,
  })
}

function normalizeReleaseNoteInput(input: ReleaseNoteInput) {
  const publishedAt = input.isPublished
    ? input.publishedAt || new Date().toISOString()
    : input.publishedAt || null

  return {
    slug: input.slug.trim(),
    title: input.title.trim(),
    summary: input.summary.trim(),
    body: input.body?.trim() || null,
    category: input.category,
    visibility: input.visibility,
    href: input.href?.trim() || null,
    cta_label: input.ctaLabel?.trim() || null,
    org_id: input.orgId || null,
    audience_roles: input.audienceRoles ?? [],
    audience_permissions: input.audiencePermissions ?? [],
    audience_features: input.audienceFeatures ?? [],
    is_published: input.isPublished,
    published_at: publishedAt,
    expires_at: input.expiresAt || null,
    updated_at: new Date().toISOString(),
  }
}

export async function listReleaseNotesForAdmin(): Promise<AdminReleaseNote[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("release_notes")
    .select(
      "id, slug, title, summary, body, category, visibility, href, cta_label, org_id, audience_roles, audience_permissions, audience_features, is_published, published_at, expires_at, created_at",
    )
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Unable to load release notes: ${error.message}`)
  return ((data ?? []) as ReleaseNoteRow[]).map(mapAdminReleaseNote)
}

export async function createReleaseNote(input: ReleaseNoteInput) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("release_notes")
    .insert(normalizeReleaseNoteInput(input))
    .select(
      "id, slug, title, summary, body, category, visibility, href, cta_label, org_id, audience_roles, audience_permissions, audience_features, is_published, published_at, expires_at, created_at",
    )
    .single()

  if (error) throw new Error(`Unable to create release note: ${error.message}`)
  return mapAdminReleaseNote(data as ReleaseNoteRow)
}

export async function updateReleaseNote(id: string, input: ReleaseNoteInput) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("release_notes")
    .update(normalizeReleaseNoteInput(input))
    .eq("id", id)
    .select(
      "id, slug, title, summary, body, category, visibility, href, cta_label, org_id, audience_roles, audience_permissions, audience_features, is_published, published_at, expires_at, created_at",
    )
    .single()

  if (error) throw new Error(`Unable to update release note: ${error.message}`)
  return mapAdminReleaseNote(data as ReleaseNoteRow)
}
