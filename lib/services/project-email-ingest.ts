import { createHash, randomBytes } from "node:crypto"
import { generateObject } from "ai"
import { z } from "zod"

import {
  CORRESPONDENCE_CLASSIFICATIONS,
  isCorrespondenceClassification,
  type CorrespondenceClassification,
  type CorrespondenceClassifiedBy,
  type CorrespondenceDirection,
} from "@/lib/correspondence"
import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { createSystemChangeEvent } from "@/lib/services/change-events"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { processInboundBillEmail } from "@/lib/services/payables-email-ingest"

const RESEND_API_BASE = "https://api.resend.com"
const PROJECT_PREFIX = "project-"

/** Newest N messages the log renders; the UI tells the user when it truncates. */
export const CORRESPONDENCE_PAGE_LIMIT = 200

/** Entropy appended to the readable part of an inbound address. */
const SLUG_TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
const SLUG_TOKEN_LENGTH = 7
const SLUG_NAME_MAX = 40

const EMAIL_SELECT =
  "id,direction,thread_id,from_address,to_addresses,cc_addresses,subject,classification,classified_by,classification_confidence,linked_entity_type,linked_entity_id,body_file_id,received_at,sent_at,created_at"

interface ReceivedEmail {
  id: string
  from: string
  to: string[] | string
  cc?: string[] | string
  subject?: string | null
  text?: string | null
  html?: string | null
  message_id?: string | null
  /** Date header of the original message, when the provider surfaces it. */
  date?: string | null
  /** When Resend accepted the message. */
  created_at?: string | null
}

interface ReceivedAttachment {
  id: string
  filename: string
  content_type?: string | null
  size?: number | null
  download_url: string
}

export interface CorrespondenceAttachment {
  file_id: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
}

export interface ProjectCorrespondenceRow {
  id: string
  direction: CorrespondenceDirection
  thread_id: string
  from_address: string
  to_addresses: string[]
  cc_addresses: string[]
  subject: string
  classification: CorrespondenceClassification
  classified_by: CorrespondenceClassifiedBy
  classification_confidence: number | null
  linked_entity_type: string | null
  linked_entity_id: string | null
  received_at: string | null
  sent_at: string | null
  created_at: string
  attachment_count: number
}

export interface ProjectCorrespondenceList {
  emails: ProjectCorrespondenceRow[]
  limit: number
  truncated: boolean
}

export interface ProjectCorrespondenceInbox {
  slug: string | null
  address: string | null
  /** False when no inbound mail domain is configured for the deployment. */
  inboundConfigured: boolean
}

export interface ThreadSibling {
  id: string
  subject: string
  from_address: string
  direction: CorrespondenceDirection
  occurred_at: string
}

export interface ProjectEmailDetail extends ProjectCorrespondenceRow {
  project_id: string
  body: string
  body_truncated: boolean
  attachments: CorrespondenceAttachment[]
  thread: ThreadSibling[]
}

/** Body text rendered inline in the detail sheet; the full text stays in storage. */
const BODY_PREVIEW_BYTES = 200_000

async function resendGet<T>(path: string): Promise<T> {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error("RESEND_API_KEY is not configured")
  const response = await fetch(`${RESEND_API_BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } })
  if (!response.ok) throw new Error(`Resend API failed: ${response.status}`)
  return response.json() as Promise<T>
}

function bareAddress(value: string) {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase()
}

function localPart(value: string) {
  return bareAddress(value).split("@")[0] ?? ""
}

/** First parseable timestamp in the list, as an ISO string. */
function firstTimestamp(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const parsed = new Date(candidate)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return null
}

export async function findProjectByInboundRecipients(recipients: string[]) {
  const slugs = recipients
    .map(localPart)
    .filter((value) => value.startsWith(PROJECT_PREFIX))
    .map((value) => value.slice(PROJECT_PREFIX.length))
    .filter(Boolean)
  if (!slugs.length) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("projects")
    .select("id,org_id,correspondence_slug")
    .in("correspondence_slug", slugs)
    .limit(1)
    .maybeSingle()
  return data ? { projectId: data.id as string, orgId: data.org_id as string, slug: data.correspondence_slug as string } : null
}

/**
 * The address vendors and owners BCC to file mail against a project. Returns
 * null unless BOTH the deployment domain and the project's slug exist —
 * rendering `project-@domain` would hand the user a live-looking address that
 * silently drops every message sent to it.
 */
export function projectInboundAddress(slug: string | null | undefined): string | null {
  const domain = process.env.PAYABLES_INBOUND_DOMAIN
  if (!domain || !slug) return null
  return `${PROJECT_PREFIX}${slug}@${domain}`
}

function slugToken() {
  const bytes = randomBytes(SLUG_TOKEN_LENGTH)
  return Array.from(bytes, (byte) => SLUG_TOKEN_ALPHABET[byte % SLUG_TOKEN_ALPHABET.length]).join("")
}

/**
 * Readable stem plus entropy. The stem makes the address recognizable in a
 * vendor's sent folder; the token keeps it unguessable, because an inbound
 * address is an unauthenticated write into the project's record.
 */
function buildCorrespondenceSlug(projectName: string) {
  const stem =
    projectName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_NAME_MAX)
      .replace(/-+$/g, "") || "project"
  return `${stem}-${slugToken()}`
}

export async function getProjectCorrespondenceInbox(
  projectId: string,
  orgId?: string,
): Promise<ProjectCorrespondenceInbox> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "correspondence.read")
  const { data, error } = await context.supabase
    .from("projects")
    .select("correspondence_slug")
    .eq("org_id", context.orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load correspondence settings: ${error.message}`)
  const slug = (data?.correspondence_slug as string | null) ?? null
  return { slug, address: projectInboundAddress(slug), inboundConfigured: Boolean(process.env.PAYABLES_INBOUND_DOMAIN) }
}

/**
 * Mints the project's inbound address. Explicit rather than lazy: the slug is a
 * durable, publishable credential, so it gets created by someone with
 * `correspondence.write` pressing a button, not as a side effect of a page load.
 */
export async function enableProjectCorrespondence(
  projectId: string,
  orgId?: string,
): Promise<ProjectCorrespondenceInbox> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "correspondence.write")
  if (!process.env.PAYABLES_INBOUND_DOMAIN) {
    throw new Error("Inbound email is not set up for this workspace yet. Ask your Arc administrator to finish setup.")
  }

  const supabase = createServiceSupabaseClient()
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,name,correspondence_slug")
    .eq("org_id", context.orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (projectError || !project) throw new Error("Project not found")
  const existing = (project.correspondence_slug as string | null) ?? null
  if (existing) {
    return { slug: existing, address: projectInboundAddress(existing), inboundConfigured: true }
  }

  // The slug's unique index spans every org, so a collision is possible even
  // though the token is random. Retry with fresh entropy rather than failing.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = buildCorrespondenceSlug(String(project.name ?? ""))
    const { data: updated, error } = await supabase
      .from("projects")
      .update({ correspondence_slug: slug })
      .eq("org_id", context.orgId)
      .eq("id", projectId)
      .is("correspondence_slug", null)
      .select("correspondence_slug")
      .maybeSingle()
    // Zero rows means a concurrent request won the race; read back its slug
    // rather than reporting one that was never stored.
    if (!error && !updated) {
      const { data: current } = await supabase
        .from("projects")
        .select("correspondence_slug")
        .eq("org_id", context.orgId)
        .eq("id", projectId)
        .maybeSingle()
      const winner = (current?.correspondence_slug as string | null) ?? null
      if (winner) return { slug: winner, address: projectInboundAddress(winner), inboundConfigured: true }
      continue
    }
    if (!error) {
      await Promise.all([
        recordEvent({
          orgId: context.orgId,
          eventType: "project_correspondence_enabled",
          entityType: "project",
          entityId: projectId,
          payload: { correspondence_slug: slug },
        }),
        recordAudit({
          orgId: context.orgId,
          action: "update",
          entityType: "project",
          entityId: projectId,
          after: { correspondence_slug: slug },
          source: "correspondence",
        }),
      ])
      return { slug, address: projectInboundAddress(slug), inboundConfigured: true }
    }
    if (error.code !== "23505") throw new Error(`Failed to enable email filing: ${error.message}`)
  }
  throw new Error("Could not reserve an inbound address. Please try again.")
}

async function attachmentCounts(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  emailIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!emailIds.length) return counts
  const { data } = await supabase
    .from("file_links")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "project_email")
    .in("entity_id", emailIds)
  for (const row of data ?? []) {
    const key = String(row.entity_id)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function mapRow(row: Record<string, unknown>, attachments: number): ProjectCorrespondenceRow {
  const classification = String(row.classification ?? "general")
  return {
    id: String(row.id),
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    thread_id: String(row.thread_id ?? ""),
    from_address: String(row.from_address ?? ""),
    to_addresses: (row.to_addresses as string[] | null) ?? [],
    cc_addresses: (row.cc_addresses as string[] | null) ?? [],
    subject: String(row.subject ?? "(No subject)"),
    classification: isCorrespondenceClassification(classification) ? classification : "general",
    classified_by: row.classified_by === "ai" ? "ai" : "user",
    classification_confidence:
      row.classification_confidence === null || row.classification_confidence === undefined
        ? null
        : Number(row.classification_confidence),
    linked_entity_type: (row.linked_entity_type as string | null) ?? null,
    linked_entity_id: (row.linked_entity_id as string | null) ?? null,
    received_at: (row.received_at as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    created_at: String(row.created_at),
    attachment_count: attachments,
  }
}

export async function listProjectCorrespondence(
  projectId: string,
  filters: { classification?: string; search?: string; direction?: string } = {},
  orgId?: string,
): Promise<ProjectCorrespondenceList> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "correspondence.read")

  let query = context.supabase
    .from("project_emails")
    .select(EMAIL_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("received_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    // One past the cap so the UI can say the list is truncated instead of
    // quietly presenting a partial record as the whole log.
    .limit(CORRESPONDENCE_PAGE_LIMIT + 1)

  if (filters.classification && isCorrespondenceClassification(filters.classification)) {
    query = query.eq("classification", filters.classification)
  }
  if (filters.direction === "inbound" || filters.direction === "outbound") {
    query = query.eq("direction", filters.direction)
  }
  const search = filters.search?.trim()
  if (search) {
    // `%` and `_` are ilike wildcards; commas and parens are structural in
    // PostgREST's `or()` grammar and would rewrite the filter rather than
    // match text. Neutralise all four before interpolating.
    const escaped = search.replace(/[%_,()]/g, " ")
    query = query.or(`subject.ilike.%${escaped}%,from_address.ilike.%${escaped}%`)
  }

  const { data, error } = await query
  if (error) throw new Error(`Failed to load correspondence: ${error.message}`)

  const rows = data ?? []
  const truncated = rows.length > CORRESPONDENCE_PAGE_LIMIT
  const page = truncated ? rows.slice(0, CORRESPONDENCE_PAGE_LIMIT) : rows
  const counts = await attachmentCounts(context.supabase, context.orgId, page.map((row) => String(row.id)))
  return {
    emails: page.map((row) => mapRow(row, counts.get(String(row.id)) ?? 0)),
    limit: CORRESPONDENCE_PAGE_LIMIT,
    truncated,
  }
}

async function loadBody(orgId: string, bodyFileId: string | null): Promise<{ body: string; truncated: boolean }> {
  if (!bodyFileId) return { body: "", truncated: false }
  const supabase = createServiceSupabaseClient()
  const { data: file } = await supabase
    .from("files")
    .select("storage_path")
    .eq("org_id", orgId)
    .eq("id", bodyFileId)
    .maybeSingle()
  if (!file?.storage_path) return { body: "", truncated: false }
  try {
    const bytes = await downloadFilesObject({ supabase, orgId, path: String(file.storage_path) })
    const truncated = bytes.length > BODY_PREVIEW_BYTES
    return { body: bytes.subarray(0, BODY_PREVIEW_BYTES).toString("utf8"), truncated }
  } catch {
    // The row is still the record of the message even if the stored body is
    // unreachable; surface the metadata rather than failing the whole sheet.
    return { body: "", truncated: false }
  }
}

export async function getProjectEmail(
  emailId: string,
  projectId: string,
  orgId?: string,
): Promise<ProjectEmailDetail | null> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "correspondence.read")

  const { data, error } = await context.supabase
    .from("project_emails")
    .select(`${EMAIL_SELECT},project_id`)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .eq("id", emailId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load email: ${error.message}`)
  if (!data) return null

  const [{ body, truncated }, links, threadRows] = await Promise.all([
    loadBody(context.orgId, (data.body_file_id as string | null) ?? null),
    context.supabase
      .from("file_links")
      .select("file_id,files:file_id(id,file_name,mime_type,size_bytes)")
      .eq("org_id", context.orgId)
      .eq("entity_type", "project_email")
      .eq("entity_id", emailId),
    context.supabase
      .from("project_emails")
      .select("id,subject,from_address,direction,received_at,sent_at,created_at")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .eq("thread_id", data.thread_id)
      .neq("id", emailId)
      .order("received_at", { ascending: true, nullsFirst: true })
      .limit(50),
  ])

  const attachments: CorrespondenceAttachment[] = (links.data ?? []).flatMap((link) => {
    // PostgREST returns a to-one embed as an object, but emits an array when it
    // cannot prove the relationship is singular. Accept both.
    const embedded = link.files
    const file = Array.isArray(embedded) ? embedded[0] : embedded
    if (!file) return []
    return [
      {
        file_id: String(file.id),
        file_name: String(file.file_name ?? "attachment"),
        mime_type: (file.mime_type as string | null) ?? null,
        size_bytes: file.size_bytes === null || file.size_bytes === undefined ? null : Number(file.size_bytes),
      },
    ]
  })

  const thread: ThreadSibling[] = (threadRows.data ?? []).map((row) => ({
    id: String(row.id),
    subject: String(row.subject ?? "(No subject)"),
    from_address: String(row.from_address ?? ""),
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    occurred_at: String(row.sent_at ?? row.received_at ?? row.created_at),
  }))

  return {
    ...mapRow(data, attachments.length),
    project_id: String(data.project_id),
    body,
    body_truncated: truncated,
    attachments,
    thread,
  }
}

/**
 * Human override of the AI's guess. The log is quasi-evidentiary, so a person
 * always outranks the model — and the row records which of the two decided.
 */
export async function reclassifyProjectEmail(
  input: { emailId: string; projectId: string; classification: CorrespondenceClassification },
  orgId?: string,
): Promise<ProjectCorrespondenceRow> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, input.projectId, "correspondence.write")

  const { data, error } = await context.supabase
    .from("project_emails")
    .update({ classification: input.classification, classified_by: "user", classification_confidence: null })
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.emailId)
    .select(EMAIL_SELECT)
    .maybeSingle()
  if (error) throw new Error(`Failed to reclassify email: ${error.message}`)
  if (!data) throw new Error("Email not found")

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: "project_email_reclassified",
      entityType: "project_email",
      entityId: input.emailId,
      payload: { project_id: input.projectId, classification: input.classification },
    }),
    recordAudit({
      orgId: context.orgId,
      action: "update",
      entityType: "project_email",
      entityId: input.emailId,
      after: { classification: input.classification, classified_by: "user" },
      source: "correspondence",
    }),
  ])
  const counts = await attachmentCounts(context.supabase, context.orgId, [input.emailId])
  return mapRow(data, counts.get(input.emailId) ?? 0)
}

/**
 * Promotes an email to a change event by hand — the same destination the
 * classifier reaches on a high-confidence `co_trigger`, for the cases it missed.
 */
export async function logProjectEmailAsChangeEvent(
  input: { emailId: string; projectId: string },
  orgId?: string,
): Promise<ProjectCorrespondenceRow> {
  const context = await requireOrgContext(orgId)
  await Promise.all([
    requireProjectPermission(context.userId, input.projectId, "correspondence.write"),
    requireProjectPermission(context.userId, input.projectId, "change_events.write"),
  ])

  const { data: email } = await context.supabase
    .from("project_emails")
    .select("id,subject,body_file_id,linked_entity_id")
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.emailId)
    .maybeSingle()
  if (!email) throw new Error("Email not found")
  if (email.linked_entity_id) throw new Error("This email is already linked to a record.")

  const { body } = await loadBody(context.orgId, (email.body_file_id as string | null) ?? null)
  const event = await createSystemChangeEvent({
    orgId: context.orgId,
    projectId: input.projectId,
    title: String(email.subject),
    description: body || null,
    originType: "email",
    originId: input.emailId,
  })

  const { data, error } = await context.supabase
    .from("project_emails")
    .update({ linked_entity_type: "change_event", linked_entity_id: event.id })
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.emailId)
    .select(EMAIL_SELECT)
    .maybeSingle()
  if (error || !data) throw new Error(`Failed to link change event: ${error?.message ?? "email not found"}`)

  await recordAudit({
    orgId: context.orgId,
    action: "update",
    entityType: "project_email",
    entityId: input.emailId,
    after: { linked_entity_type: "change_event", linked_entity_id: event.id },
    source: "correspondence",
  })
  const counts = await attachmentCounts(context.supabase, context.orgId, [input.emailId])
  return mapRow(data, counts.get(input.emailId) ?? 0)
}

/** Detaches a bad link. The linked record itself is left alone. */
export async function unlinkProjectEmail(
  input: { emailId: string; projectId: string },
  orgId?: string,
): Promise<ProjectCorrespondenceRow> {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, input.projectId, "correspondence.write")

  const { data, error } = await context.supabase
    .from("project_emails")
    .update({ linked_entity_type: null, linked_entity_id: null })
    .eq("org_id", context.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.emailId)
    .select(EMAIL_SELECT)
    .maybeSingle()
  if (error) throw new Error(`Failed to unlink email: ${error.message}`)
  if (!data) throw new Error("Email not found")

  await recordAudit({
    orgId: context.orgId,
    action: "update",
    entityType: "project_email",
    entityId: input.emailId,
    after: { linked_entity_type: null, linked_entity_id: null },
    source: "correspondence",
  })
  const counts = await attachmentCounts(context.supabase, context.orgId, [input.emailId])
  return mapRow(data, counts.get(input.emailId) ?? 0)
}

async function persistBodyFile(input: { orgId: string; projectId: string; emailId: string; body: string }) {
  const supabase = createServiceSupabaseClient()
  const bytes = Buffer.from(input.body, "utf8")
  const storagePath = `${input.orgId}/${input.projectId}/correspondence/${input.emailId}/body.txt`
  await uploadFilesObject({ supabase, orgId: input.orgId, path: storagePath, bytes, contentType: "text/plain", upsert: true })
  const { data: existing } = await supabase
    .from("files")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("storage_path", storagePath)
    .maybeSingle()
  if (existing) return existing.id
  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      file_name: "email-body.txt",
      storage_path: storagePath,
      mime_type: "text/plain",
      size_bytes: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      visibility: "private",
      category: "other",
      folder_path: "/correspondence",
      source: "email",
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to store email body: ${error?.message}`)
  return data.id
}

async function persistAttachment(input: {
  orgId: string
  projectId: string
  emailId: string
  attachment: ReceivedAttachment
}) {
  const response = await fetch(input.attachment.download_url)
  if (!response.ok) throw new Error(`Failed to download email attachment: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const safeName = input.attachment.filename.replace(/[/\\]/g, "-") || "attachment"
  const storagePath = `${input.orgId}/${input.projectId}/correspondence/${input.emailId}/${crypto.randomUUID()}-${safeName}`
  const supabase = createServiceSupabaseClient()
  await uploadFilesObject({
    supabase,
    orgId: input.orgId,
    path: storagePath,
    bytes,
    contentType: input.attachment.content_type ?? "application/octet-stream",
    upsert: false,
  })
  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      file_name: safeName,
      storage_path: storagePath,
      mime_type: input.attachment.content_type ?? "application/octet-stream",
      size_bytes: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      visibility: "private",
      category: "other",
      folder_path: "/correspondence",
      source: "email",
    })
    .select("id")
    .single()
  if (error || !data) throw new Error(`Failed to store email attachment: ${error?.message}`)
  return data.id
}

/**
 * Active member addresses for the org. A message BCC'd to the project address
 * *by* a team member is the builder's own outbound notice — filing it as
 * inbound would leave the log showing only one side of a dispute.
 */
async function orgMemberAddresses(orgId: string): Promise<Set<string>> {
  const supabase = createServiceSupabaseClient()
  const { data: members } = await supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("status", "active")
  const userIds = (members ?? []).map((row) => String(row.user_id)).filter(Boolean)
  if (!userIds.length) return new Set()
  const { data: users } = await supabase.from("app_users").select("email").in("id", userIds)
  return new Set((users ?? []).map((row) => String(row.email ?? "").toLowerCase()).filter(Boolean))
}

export async function processInboundProjectEmail(input: {
  orgId: string
  projectId: string
  emailId: string
  /** Provider receipt time from the webhook, used when the API omits its own. */
  receivedAt?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const email = await resendGet<ReceivedEmail>(`/emails/receiving/${encodeURIComponent(input.emailId)}`)
  const { data: duplicate } = await supabase
    .from("project_emails")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("message_id", email.message_id ?? email.id)
    .maybeSingle()
  if (duplicate) return duplicate

  const body =
    email.text?.trim() ||
    email.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ||
    "(No message body)"
  const bodyFileId = await persistBodyFile({ ...input, body })
  const attachments = await resendGet<{ data: ReceivedAttachment[] }>(
    `/emails/receiving/${encodeURIComponent(input.emailId)}/attachments`,
  )
  const attachmentIds = await Promise.all(
    (attachments.data ?? []).slice(0, 25).map((attachment) => persistAttachment({ ...input, attachment })),
  )

  const to = Array.isArray(email.to) ? email.to : [email.to]
  const cc = !email.cc ? [] : Array.isArray(email.cc) ? email.cc : [email.cc]
  const messageId = email.message_id ?? email.id
  const threadId = createHash("sha256")
    .update(`${input.projectId}:${(email.subject ?? "").replace(/^(re|fwd?):\s*/i, "").toLowerCase()}`)
    .digest("hex")

  const fromAddress = bareAddress(email.from)
  const members = await orgMemberAddresses(input.orgId)
  const direction: CorrespondenceDirection = members.has(fromAddress) ? "outbound" : "inbound"
  // `sent_at` is when the message was written, `received_at` when Arc filed it.
  // Both come off the provider — stamping either with the cron's clock would
  // put the log minutes or hours away from the timeline it is evidence of.
  const now = new Date().toISOString()
  const sentAt = firstTimestamp(email.date, email.created_at)
  const receivedAt = firstTimestamp(email.created_at, input.receivedAt, email.date) ?? now

  const payload = {
    org_id: input.orgId,
    project_id: input.projectId,
    direction,
    message_id: messageId,
    provider_email_id: input.emailId,
    thread_id: threadId,
    from_address: fromAddress,
    to_addresses: to.map(bareAddress),
    cc_addresses: cc.map(bareAddress),
    subject: email.subject?.trim() || "(No subject)",
    body_file_id: bodyFileId,
    classification: "general",
    classified_by: "user",
    received_at: receivedAt,
    sent_at: sentAt,
  }
  const { data, error } = await supabase.from("project_emails").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to file project email: ${error?.message}`)

  if (attachmentIds.length) {
    const { error: linkError } = await supabase.from("file_links").insert(
      attachmentIds.map((fileId) => ({
        org_id: input.orgId,
        project_id: input.projectId,
        file_id: fileId,
        entity_type: "project_email",
        entity_id: data.id,
        link_role: "attachment",
      })),
    )
    if (linkError) throw new Error(`Failed to link email attachments: ${linkError.message}`)
  }

  await enqueueOutboxJob({
    orgId: input.orgId,
    jobType: "classify_project_email",
    payload: { project_email_id: data.id, body },
    dedupeByPayloadKeys: ["project_email_id"],
  })
  await Promise.all([
    recordEvent({
      orgId: input.orgId,
      eventType: "project_email_received",
      entityType: "project_email",
      entityId: data.id,
      payload: {
        project_id: input.projectId,
        subject: payload.subject,
        direction,
        attachment_count: attachmentIds.length,
      },
    }),
    recordAudit({
      orgId: input.orgId,
      action: "insert",
      entityType: "project_email",
      entityId: data.id,
      after: payload,
      source: "resend_inbound",
    }),
  ])
  return data
}

const classificationSchema = z.object({
  classification: z.enum(CORRESPONDENCE_CLASSIFICATIONS),
  confidence: z.number().min(0).max(1),
})

const CLASSIFY_PROMPT = `Classify this construction project email.
- correspondence: a formal notice, claim, or letter of record
- rfi_related: answers or raises a request for information
- co_trigger: a credible scope, cost, or schedule change — not merely discussion of one
- bill: an invoice or bill from a vendor
- submittal_related: concerns a submittal, shop drawing, or product data
- general: routine traffic that fits none of the above`

export async function classifyProjectEmail(input: { orgId: string; projectEmailId: string; body?: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: email, error } = await supabase
    .from("project_emails")
    .select("id,project_id,provider_email_id,subject,from_address,classification,classified_by,linked_entity_id")
    .eq("org_id", input.orgId)
    .eq("id", input.projectEmailId)
    .maybeSingle()
  if (error || !email) throw new Error("Project email not found")

  // A person already ruled on this one; the model does not get to overwrite them.
  const current = String(email.classification ?? "general")
  if (email.classified_by === "user" && current !== "general" && isCorrespondenceClassification(current)) {
    return { classification: current, confidence: null }
  }

  if (!(await isAiSearchEnabledForOrg({ supabase, orgId: input.orgId }))) {
    return { classification: "general" as CorrespondenceClassification, confidence: null }
  }
  const config = await getPlatformAiFeatureDefaultConfig({ supabase, feature: "document_extraction" })
  const key = getApiKeyForProvider(config.provider)
  // No key means no classification happened — leaving the row untouched keeps
  // `classified_by` honest instead of stamping an unclassified row as AI-rated.
  if (!key) return { classification: "general" as CorrespondenceClassification, confidence: null }

  const { object: classification } = await generateObject({
    model: resolveLanguageModel(config.provider, key, config.model),
    schema: classificationSchema,
    prompt: `${CLASSIFY_PROMPT}\n\nSubject: ${email.subject}\nFrom: ${email.from_address}\nBody: ${(input.body ?? "").slice(0, 20_000)}`,
    abortSignal: AbortSignal.timeout(60_000),
  })

  const { error: updateError } = await supabase
    .from("project_emails")
    .update({
      classification: classification.classification,
      classified_by: "ai",
      classification_confidence: classification.confidence,
    })
    .eq("org_id", input.orgId)
    .eq("id", input.projectEmailId)
  if (updateError) throw new Error(`Failed to classify project email: ${updateError.message}`)

  if (classification.classification === "co_trigger" && classification.confidence >= 0.75 && !email.linked_entity_id) {
    const event = await createSystemChangeEvent({
      orgId: input.orgId,
      projectId: email.project_id,
      title: email.subject,
      description: input.body ?? null,
      originType: "email",
      originId: email.id,
    })
    await supabase
      .from("project_emails")
      .update({ linked_entity_type: "change_event", linked_entity_id: event.id })
      .eq("org_id", input.orgId)
      .eq("id", input.projectEmailId)
  }
  if (classification.classification === "bill" && classification.confidence >= 0.75) {
    if (email.provider_email_id) {
      await processInboundBillEmail({
        orgId: input.orgId,
        emailId: email.provider_email_id,
        preferredProjectId: email.project_id,
      })
    }
    await recordEvent({
      orgId: input.orgId,
      eventType: "project_email_bill_detected",
      entityType: "project_email",
      entityId: email.id,
      payload: { project_id: email.project_id, routed_to_ap_ingest: Boolean(email.provider_email_id) },
    })
  }
  return classification
}
