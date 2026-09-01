/**
 * The project correspondence workbench.
 *
 * This owns everything a person does with filed mail: reading the log as
 * threads, ruling on what a message is, attaching it to the records it is
 * about, and unfiling what does not belong.
 *
 * Arc never sends from here. Mail arrives one way — someone forwards or BCCs it
 * to the project's address, the same shape as the payables bills inbox — so the
 * log is a record of correspondence that happened, not a mail client.
 *
 * `lib/services/project-email-ingest.ts` is the other half — the inbound
 * pipeline that puts messages here. It imports from this module and never the
 * other way around.
 */

import { createHash } from "node:crypto"

import {
  CLASSIFICATION_FILE_CATEGORIES,
  LINKABLE_ENTITY_PERMISSIONS,
  LINK_IMPLIED_CLASSIFICATION,
  isCorrespondenceClassification,
  isLinkableEntityType,
  normalizeSubject,
  type CorrespondenceClassification,
  type CorrespondenceClassifiedBy,
  type CorrespondenceDirection,
  type LinkableEntityType,
} from "@/lib/correspondence"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { requireOrgContext, type OrgServiceContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { listChangeEvents } from "@/lib/services/change-events"
import { listRfis } from "@/lib/services/rfis"
import { listSubmittals } from "@/lib/services/submittals"
import { listVendorBillsForProject } from "@/lib/services/vendor-bills"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import {
  archivedCorrespondenceFilterSchema,
  archiveSchema,
  confirmClassificationSchema,
  correspondenceFilterSchema,
  emailScopeSchema,
  linkSchema,
  linkTargetSearchSchema,
  reclassifySchema,
  threadScopeSchema,
  unlinkSchema,
  type ArchivedCorrespondenceFilterInput,
  type CorrespondenceFilterInput,
} from "@/lib/validation/correspondence"

const PROJECT_PREFIX = "project-"

/** Body text rendered inline in the detail sheet; the full text stays in storage. */
const BODY_PREVIEW_BYTES = 200_000

/** Leading text denormalized onto the row so the log is searchable. */
const BODY_SNIPPET_CHARS = 2_000

const EMAIL_SELECT =
  "id,project_id,direction,thread_id,message_id,in_reply_to,reference_ids,from_address,to_addresses,cc_addresses,subject,classification,classified_by,classification_confidence,contact_id,company_id,body_file_id,body_preview,archived_at,received_at,sent_at,created_at"

const THREAD_SELECT =
  "thread_id,subject,last_direction,counterparty_address,counterparty_contact_id,counterparty_company_id,counterparty_name,last_body_preview,message_count,last_message_at,attachment_count,link_count,unreviewed_count,has_inbound,has_outbound,classifications"

export interface CorrespondenceAttachment {
  file_id: string
  file_name: string
  mime_type: string | null
  size_bytes: number | null
}

export interface CorrespondenceLink {
  id: string
  entity_type: LinkableEntityType
  entity_id: string
  created_at: string
}

export interface CorrespondenceMessage {
  id: string
  project_id: string
  direction: CorrespondenceDirection
  thread_id: string
  message_id: string | null
  from_address: string
  to_addresses: string[]
  cc_addresses: string[]
  subject: string
  classification: CorrespondenceClassification
  classified_by: CorrespondenceClassifiedBy
  classification_confidence: number | null
  contact_id: string | null
  company_id: string | null
  body_preview: string | null
  archived_at: string | null
  received_at: string | null
  sent_at: string | null
  created_at: string
  occurred_at: string
  attachment_count: number
  links: CorrespondenceLink[]
}

export interface CorrespondenceThread {
  thread_id: string
  subject: string
  last_direction: CorrespondenceDirection
  counterparty_address: string
  counterparty_name: string
  counterparty_contact_id: string | null
  counterparty_company_id: string | null
  snippet: string | null
  message_count: number
  last_message_at: string
  attachment_count: number
  link_count: number
  unreviewed_count: number
  has_inbound: boolean
  has_outbound: boolean
  classifications: CorrespondenceClassification[]
}

export interface CorrespondenceThreadPage {
  threads: CorrespondenceThread[]
  total: number
  page: number
  pageSize: number
}

interface ArchivedCorrespondencePage {
  messages: CorrespondenceMessage[]
  total: number
  page: number
  pageSize: number
}

/**
 * One row of the log, whichever pile it came from.
 *
 * The filed log is a list of conversations and the unfiled pile is a list of
 * messages, but the reader is looking at one list of mail either way. Flatten
 * the two into a single row shape here, in the service, rather than making the
 * page hold two lists and a mode flag — that split is what produced the old
 * log/unfiled tab bar.
 */
export interface CorrespondenceListItem {
  /** What opening this row reads: a whole conversation, or one loose message. */
  kind: "thread" | "message"
  /** Thread id or email id, depending on `kind`. Unique within a page. */
  id: string
  subject: string
  direction: CorrespondenceDirection
  counterparty_name: string
  counterparty_address: string
  counterparty_contact_id: string | null
  counterparty_company_id: string | null
  snippet: string | null
  message_count: number
  occurred_at: string
  attachment_count: number
  link_count: number
  unreviewed_count: number
  classifications: CorrespondenceClassification[]
  archived: boolean
}

export interface CorrespondenceListPage {
  items: CorrespondenceListItem[]
  total: number
  page: number
  pageSize: number
}

export interface ProjectEmailDetail extends CorrespondenceMessage {
  body: string
  body_truncated: boolean
  /** The stored body file, so a truncated message can still be read in full. */
  body_file_id: string | null
  attachments: CorrespondenceAttachment[]
}

export interface CorrespondenceThreadDetail {
  thread_id: string
  subject: string
  messages: ProjectEmailDetail[]
  /** True when the conversation is longer than one sheet renders. */
  truncated: boolean
  total_message_count: number
}

export interface ProjectCorrespondenceInbox {
  /**
   * Null only when no inbound mail domain is configured for the deployment.
   * Every project carries a slug from the moment it is inserted, so there is no
   * per-project "not set up yet" state, and no second flag worth carrying: a
   * null address IS "inbound email is not connected".
   */
  address: string | null
}

export interface LinkTarget {
  id: string
  label: string
  sublabel: string | null
}

// ── Addresses ───────────────────────────────────────────────────────────────

/**
 * The address people forward or BCC to file mail against a project. Returns
 * null unless BOTH the deployment domain and the project's slug exist —
 * rendering `project-@domain` would hand the user a live-looking address that
 * silently drops every message sent to it.
 *
 * The slug itself is minted by `projects_set_correspondence_slug`, a trigger on
 * insert, so nothing in the application ever has to create one.
 */
function projectInboundAddress(slug: string | null | undefined): string | null {
  const domain = process.env.PAYABLES_INBOUND_DOMAIN
  if (!domain || !slug) return null
  return `${PROJECT_PREFIX}${slug}@${domain}`
}

export function inboundSlugsFromRecipients(recipients: string[]): string[] {
  return recipients
    .map((value) => bareAddress(value).split("@")[0] ?? "")
    .filter((value) => value.startsWith(PROJECT_PREFIX))
    .map((value) => value.slice(PROJECT_PREFIX.length))
    .filter(Boolean)
}

export function bareAddress(value: string) {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase()
}

// ── Shared row shape ────────────────────────────────────────────────────────

/**
 * PostgREST puts `in.(…)` filters in the query string, so a bulk ruling over a
 * few hundred conversations would build a URL the server refuses. Every bulk
 * write walks the selection in batches instead.
 */
const WRITE_BATCH = 100

function chunk<T>(values: T[], size = WRITE_BATCH): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

export function bodySnippet(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, BODY_SNIPPET_CHARS)
}

/** Timestamp of record: when the message was written, else when Arc filed it. */
function occurredAt(row: { sent_at: unknown; received_at: unknown; created_at: unknown }) {
  return String(row.sent_at ?? row.received_at ?? row.created_at)
}

function mapMessage(
  row: Record<string, unknown>,
  extras: { attachments: number; links: CorrespondenceLink[] },
): CorrespondenceMessage {
  const classification = String(row.classification ?? "general")
  const classifiedBy = String(row.classified_by ?? "system")
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    thread_id: String(row.thread_id ?? ""),
    message_id: (row.message_id as string | null) ?? null,
    from_address: String(row.from_address ?? ""),
    to_addresses: (row.to_addresses as string[] | null) ?? [],
    cc_addresses: (row.cc_addresses as string[] | null) ?? [],
    subject: String(row.subject ?? "(No subject)"),
    classification: isCorrespondenceClassification(classification) ? classification : "general",
    classified_by:
      classifiedBy === "ai" || classifiedBy === "user" ? (classifiedBy as CorrespondenceClassifiedBy) : "system",
    classification_confidence:
      row.classification_confidence === null || row.classification_confidence === undefined
        ? null
        : Number(row.classification_confidence),
    contact_id: (row.contact_id as string | null) ?? null,
    company_id: (row.company_id as string | null) ?? null,
    body_preview: (row.body_preview as string | null) ?? null,
    archived_at: (row.archived_at as string | null) ?? null,
    received_at: (row.received_at as string | null) ?? null,
    sent_at: (row.sent_at as string | null) ?? null,
    created_at: String(row.created_at),
    occurred_at: occurredAt(row as { sent_at: unknown; received_at: unknown; created_at: unknown }),
    attachment_count: extras.attachments,
    links: extras.links,
  }
}

async function attachmentCounts(
  supabase: OrgServiceContext["supabase"],
  orgId: string,
  emailIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (!emailIds.length) return counts
  for (const batch of chunk(emailIds)) {
    const { data } = await supabase
      .from("file_links")
      .select("entity_id")
      .eq("org_id", orgId)
      .eq("entity_type", "project_email")
      .in("entity_id", batch)
    for (const row of data ?? []) {
      const key = String(row.entity_id)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return counts
}

async function linksByEmail(
  supabase: OrgServiceContext["supabase"],
  orgId: string,
  emailIds: string[],
): Promise<Map<string, CorrespondenceLink[]>> {
  const links = new Map<string, CorrespondenceLink[]>()
  if (!emailIds.length) return links
  const rows: Record<string, unknown>[] = []
  for (const batch of chunk(emailIds)) {
    const { data } = await supabase
      .from("project_email_links")
      .select("id,project_email_id,entity_type,entity_id,created_at")
      .eq("org_id", orgId)
      .in("project_email_id", batch)
      .order("created_at", { ascending: true })
    rows.push(...((data ?? []) as Record<string, unknown>[]))
  }
  for (const row of rows) {
    const entityType = String(row.entity_type)
    if (!isLinkableEntityType(entityType)) continue
    const key = String(row.project_email_id)
    const list = links.get(key) ?? []
    list.push({
      id: String(row.id),
      entity_type: entityType,
      entity_id: String(row.entity_id),
      created_at: String(row.created_at),
    })
    links.set(key, list)
  }
  return links
}

/** Hydrates the two per-message rollups every message shape needs. */
async function hydrateMessages(
  supabase: OrgServiceContext["supabase"],
  orgId: string,
  rows: Record<string, unknown>[],
): Promise<CorrespondenceMessage[]> {
  const ids = rows.map((row) => String(row.id))
  const [counts, links] = await Promise.all([
    attachmentCounts(supabase, orgId, ids),
    linksByEmail(supabase, orgId, ids),
  ])
  return rows.map((row) =>
    mapMessage(row, {
      attachments: counts.get(String(row.id)) ?? 0,
      links: links.get(String(row.id)) ?? [],
    }),
  )
}

// ── The project's address ───────────────────────────────────────────────────

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
  return { address: projectInboundAddress((data?.correspondence_slug as string | null) ?? null) }
}

// ── Bodies in storage ───────────────────────────────────────────────────────

export async function loadBody(orgId: string, bodyFileId: string | null): Promise<{ body: string; truncated: boolean }> {
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

export async function persistBodyFile(input: {
  orgId: string
  projectId: string
  emailId: string
  body: string
}): Promise<string> {
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
  if (existing) return String(existing.id)
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
  return String(data.id)
}

// ── Directory attribution ───────────────────────────────────────────────────

/**
 * Which directory party a message is with. Run at ingest and on send, not just
 * in a one-time backfill: `project_emails.contact_id` is what the party's
 * Communications tab reads, so a message filed without it is invisible there
 * forever.
 */
export async function resolvePartyForAddress(
  supabase: OrgServiceContext["supabase"],
  orgId: string,
  address: string | null | undefined,
): Promise<{ contactId: string | null; companyId: string | null }> {
  const value = address ? bareAddress(address) : ""
  if (!value) return { contactId: null, companyId: null }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("org_id", orgId)
    .is("archived_at", null)
    .eq("email", value)
    .limit(1)
    .maybeSingle()

  if (contact?.id) {
    const { data: link } = await supabase
      .from("contact_company_links")
      .select("company_id")
      .eq("org_id", orgId)
      .eq("contact_id", contact.id)
      .order("is_primary", { ascending: false })
      .limit(1)
      .maybeSingle()
    return { contactId: String(contact.id), companyId: link?.company_id ? String(link.company_id) : null }
  }

  // No person matched, but the address may be a company's main mailbox.
  // `contacts.email` is citext so `eq` is already case-insensitive there;
  // `companies.email` is plain text, so a wildcard-free ilike is what makes
  // "Info@Vendor.com" match the address as it arrived on the wire.
  const { data: company } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", orgId)
    .is("archived_at", null)
    .ilike("email", value)
    .limit(1)
    .maybeSingle()
  return { contactId: null, companyId: company?.id ? String(company.id) : null }
}

// ── Threading ───────────────────────────────────────────────────────────────

/** Deterministic fallback for mail that carries no threading headers at all. */
function subjectThreadId(projectId: string, subject: string): string {
  return createHash("sha256").update(`${projectId}:${normalizeSubject(subject)}`).digest("hex")
}

/**
 * Joins a message to the conversation it belongs to.
 *
 * `In-Reply-To` first, then the `References` chain — a reply whose immediate
 * parent was never filed still lands on the right thread. The subject hash is
 * last, because it is the rule that used to merge two unrelated "Site update"
 * chains into one.
 */
export async function resolveThreadId(input: {
  supabase: OrgServiceContext["supabase"]
  orgId: string
  projectId: string
  subject: string
  inReplyTo: string | null
  references: string[]
}): Promise<string> {
  const candidates = [input.inReplyTo, ...[...input.references].reverse()].filter(
    (value): value is string => Boolean(value),
  )
  if (candidates.length) {
    const { data } = await input.supabase
      .from("project_emails")
      .select("message_id,thread_id")
      .eq("org_id", input.orgId)
      .eq("project_id", input.projectId)
      .in("message_id", candidates)
    const byMessageId = new Map((data ?? []).map((row) => [String(row.message_id), String(row.thread_id)]))
    for (const candidate of candidates) {
      const threadId = byMessageId.get(candidate)
      if (threadId) return threadId
    }
  }
  return subjectThreadId(input.projectId, input.subject)
}

// ── Reading the log ─────────────────────────────────────────────────────────

/**
 * `%` and `_` are ilike wildcards; commas and parens are structural in
 * PostgREST's filter grammar and would rewrite the filter rather than match
 * text. Neutralise all four before interpolating.
 */
function escapeSearch(value: string): string {
  return value.replace(/[%_,()]/g, " ").trim()
}

function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`
}

function mapThread(row: Record<string, unknown>): CorrespondenceThread {
  const classifications = ((row.classifications as string[] | null) ?? []).filter(isCorrespondenceClassification)
  return {
    thread_id: String(row.thread_id),
    subject: String(row.subject ?? "(No subject)"),
    last_direction: row.last_direction === "outbound" ? "outbound" : "inbound",
    counterparty_address: String(row.counterparty_address ?? ""),
    counterparty_name: String(row.counterparty_name ?? row.counterparty_address ?? ""),
    counterparty_contact_id: (row.counterparty_contact_id as string | null) ?? null,
    counterparty_company_id: (row.counterparty_company_id as string | null) ?? null,
    snippet: (row.last_body_preview as string | null) ?? null,
    message_count: Number(row.message_count ?? 0),
    last_message_at: String(row.last_message_at),
    attachment_count: Number(row.attachment_count ?? 0),
    link_count: Number(row.link_count ?? 0),
    unreviewed_count: Number(row.unreviewed_count ?? 0),
    has_inbound: Boolean(row.has_inbound),
    has_outbound: Boolean(row.has_outbound),
    classifications,
  }
}

/**
 * The log, as threads. Every filter, the ordering, the count and the page
 * boundary are pushed into `project_email_threads` — the previous version
 * fetched the newest 200 messages and told the user to narrow the search to
 * reach anything older, which meant message 201 was unreachable.
 */
export async function listCorrespondenceThreads(
  input: CorrespondenceFilterInput,
  orgId?: string,
): Promise<CorrespondenceThreadPage> {
  const filters = correspondenceFilterSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, filters.projectId, "correspondence.read")

  let query = context.supabase
    .from("project_email_threads")
    .select(THREAD_SELECT, { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("project_id", filters.projectId)

  if (filters.classification) query = query.overlaps("classifications", [filters.classification])
  if (filters.direction === "inbound") query = query.eq("has_inbound", true)
  if (filters.direction === "outbound") query = query.eq("has_outbound", true)
  if (filters.needsReview) query = query.gt("unreviewed_count", 0)
  if (filters.linked === "linked") query = query.gt("link_count", 0)
  if (filters.linked === "unlinked") query = query.eq("link_count", 0)
  if (filters.hasAttachments) query = query.gt("attachment_count", 0)
  if (filters.from) query = query.gte("last_message_at", filters.from)
  if (filters.to) query = query.lte("last_message_at", endOfDay(filters.to))

  const search = filters.search ? escapeSearch(filters.search) : ""
  if (search) query = query.ilike("search_haystack", `%${search}%`)

  const offset = (filters.page - 1) * filters.pageSize
  const { data, error, count } = await query
    .order("last_message_at", { ascending: false })
    .order("thread_id", { ascending: true })
    .range(offset, offset + filters.pageSize - 1)
  if (error) throw new Error(`Failed to load correspondence: ${error.message}`)

  return {
    threads: (data ?? []).map((row) => mapThread(row as Record<string, unknown>)),
    total: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  }
}

/**
 * Unfiled mail: spam to the public address, or a message filed against the
 * wrong project. Kept as rows rather than deleted, and listed flat — a thread
 * rollup over archived messages would only ever describe what was thrown out.
 */
async function listArchivedCorrespondence(
  input: ArchivedCorrespondenceFilterInput,
  orgId?: string,
): Promise<ArchivedCorrespondencePage> {
  const filters = archivedCorrespondenceFilterSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, filters.projectId, "correspondence.read")

  let query = context.supabase
    .from("project_emails")
    .select(EMAIL_SELECT, { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("project_id", filters.projectId)
    .not("archived_at", "is", null)

  const search = filters.search ? escapeSearch(filters.search) : ""
  if (search) {
    query = query.or(`subject.ilike.%${search}%,from_address.ilike.%${search}%,body_preview.ilike.%${search}%`)
  }

  const offset = (filters.page - 1) * filters.pageSize
  const { data, error, count } = await query
    .order("archived_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + filters.pageSize - 1)
  if (error) throw new Error(`Failed to load archived correspondence: ${error.message}`)

  return {
    messages: await hydrateMessages(context.supabase, context.orgId, (data ?? []) as Record<string, unknown>[]),
    total: count ?? 0,
    page: filters.page,
    pageSize: filters.pageSize,
  }
}

/**
 * The log as one list, whichever pile the filters point at.
 *
 * Filed mail is aggregated into conversations by `project_email_threads`;
 * unfiled mail stays a flat list of messages, because a thread rollup over
 * archived rows would only ever describe what somebody threw out. Both come
 * back as `CorrespondenceListItem`, so there is one list surface and one set of
 * controls above it.
 */
export async function listCorrespondence(
  input: CorrespondenceFilterInput,
  orgId?: string,
): Promise<CorrespondenceListPage> {
  const filters = correspondenceFilterSchema.parse(input)

  if (filters.status === "unfiled") {
    const page = await listArchivedCorrespondence(
      {
        projectId: filters.projectId,
        search: filters.search,
        page: filters.page,
        pageSize: filters.pageSize,
      },
      orgId,
    )
    return {
      items: page.messages.map(messageListItem),
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    }
  }

  const page = await listCorrespondenceThreads(filters, orgId)
  return {
    items: page.threads.map(threadListItem),
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
  }
}

function threadListItem(thread: CorrespondenceThread): CorrespondenceListItem {
  return {
    kind: "thread",
    id: thread.thread_id,
    subject: thread.subject,
    direction: thread.last_direction,
    counterparty_name: thread.counterparty_name,
    counterparty_address: thread.counterparty_address,
    counterparty_contact_id: thread.counterparty_contact_id,
    counterparty_company_id: thread.counterparty_company_id,
    snippet: thread.snippet,
    message_count: thread.message_count,
    occurred_at: thread.last_message_at,
    attachment_count: thread.attachment_count,
    link_count: thread.link_count,
    unreviewed_count: thread.unreviewed_count,
    classifications: thread.classifications,
    archived: false,
  }
}

function messageListItem(message: CorrespondenceMessage): CorrespondenceListItem {
  const counterparty =
    message.direction === "inbound" ? message.from_address : message.to_addresses[0] ?? message.from_address
  return {
    kind: "message",
    id: message.id,
    subject: message.subject,
    direction: message.direction,
    counterparty_name: counterparty,
    counterparty_address: counterparty,
    counterparty_contact_id: message.contact_id,
    counterparty_company_id: message.company_id,
    snippet: message.body_preview,
    message_count: 1,
    occurred_at: message.occurred_at,
    attachment_count: message.attachment_count,
    link_count: message.links.length,
    // Nothing in the unfiled pile is waiting on a ruling: taking it out of the
    // log IS the ruling.
    unreviewed_count: 0,
    classifications: [message.classification],
    archived: true,
  }
}

/**
 * Messages one sheet renders with their bodies. Each body is a separate object
 * read out of storage, so this is a real ceiling rather than a display choice —
 * and it keeps the NEWEST messages, because the tail of a chain is what anyone
 * opening it came for.
 */
const THREAD_MESSAGE_CAP = 50

export async function getCorrespondenceThread(
  input: { projectId: string; threadId: string },
  orgId?: string,
): Promise<CorrespondenceThreadDetail | null> {
  const parsed = threadScopeSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.read")

  const { data, error, count } = await context.supabase
    .from("project_emails")
    .select(EMAIL_SELECT, { count: "exact" })
    .eq("org_id", context.orgId)
    .eq("project_id", parsed.projectId)
    .eq("thread_id", parsed.threadId)
    .is("archived_at", null)
    .order("received_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(THREAD_MESSAGE_CAP)
  if (error) throw new Error(`Failed to load thread: ${error.message}`)
  // Newest first out of the database so the cap drops the oldest; reversed here
  // because a conversation reads forwards.
  const rows = ((data ?? []) as Record<string, unknown>[]).reverse()
  if (!rows.length) return null

  const messages = await hydrateMessages(context.supabase, context.orgId, rows)
  const details = await Promise.all(
    rows.map(async (row, index) => enrichDetail(context, messages[index], row)),
  )
  const total = count ?? details.length

  return {
    thread_id: parsed.threadId,
    subject: details[details.length - 1]?.subject ?? "(No subject)",
    messages: details,
    truncated: total > details.length,
    total_message_count: total,
  }
}

async function enrichDetail(
  context: OrgServiceContext,
  message: CorrespondenceMessage,
  row: Record<string, unknown>,
): Promise<ProjectEmailDetail> {
  const bodyFileId = (row.body_file_id as string | null) ?? null
  const [{ body, truncated }, links] = await Promise.all([
    loadBody(context.orgId, bodyFileId),
    context.supabase
      .from("file_links")
      .select("file_id,files:file_id(id,file_name,mime_type,size_bytes)")
      .eq("org_id", context.orgId)
      .eq("entity_type", "project_email")
      .eq("entity_id", message.id),
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

  return { ...message, body, body_truncated: truncated, body_file_id: bodyFileId, attachments }
}

/**
 * What the reader pane opens for a given URL.
 *
 * The log deep-links two ways — `?thread=` from the list, `?email=` from global
 * search, a notification, or a party's Communications tab — and a message that
 * has been unfiled belongs to no conversation the log shows. Resolving all
 * three into one shape here is what lets the reader be a plain component over
 * server-loaded data instead of the effect-driven fetch it replaced.
 */
export interface CorrespondenceReaderTarget {
  kind: "thread" | "message"
  /** The list row this target highlights, when that row is on the page. */
  id: string
  thread_id: string | null
  subject: string
  messages: ProjectEmailDetail[]
  truncated: boolean
  total_message_count: number
}

export async function getCorrespondenceReaderTarget(
  input: { projectId: string; emailId?: string | null; threadId?: string | null },
  orgId?: string,
): Promise<CorrespondenceReaderTarget | null> {
  if (input.emailId) {
    const email = await getProjectEmail(input.emailId, input.projectId, orgId)
    if (!email) return null
    // An unfiled message is not part of any conversation, so it reads alone.
    if (email.archived_at) return looseMessageTarget(email)
    const thread = await getCorrespondenceThread(
      { projectId: input.projectId, threadId: email.thread_id },
      orgId,
    )
    return thread ? threadTarget(thread) : looseMessageTarget(email)
  }

  if (input.threadId) {
    const thread = await getCorrespondenceThread(
      { projectId: input.projectId, threadId: input.threadId },
      orgId,
    )
    return thread ? threadTarget(thread) : null
  }

  return null
}

function threadTarget(thread: CorrespondenceThreadDetail): CorrespondenceReaderTarget {
  return {
    kind: "thread",
    id: thread.thread_id,
    thread_id: thread.thread_id,
    subject: thread.subject,
    messages: thread.messages,
    truncated: thread.truncated,
    total_message_count: thread.total_message_count,
  }
}

function looseMessageTarget(email: ProjectEmailDetail): CorrespondenceReaderTarget {
  return {
    kind: "message",
    id: email.id,
    thread_id: null,
    subject: email.subject,
    messages: [email],
    truncated: false,
    total_message_count: 1,
  }
}

export async function getProjectEmail(
  emailId: string,
  projectId: string,
  orgId?: string,
): Promise<ProjectEmailDetail | null> {
  const parsed = emailScopeSchema.parse({ projectId, emailId })
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.read")

  const { data, error } = await context.supabase
    .from("project_emails")
    .select(EMAIL_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", parsed.projectId)
    .eq("id", parsed.emailId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load email: ${error.message}`)
  if (!data) return null

  const row = data as Record<string, unknown>
  const [message] = await hydrateMessages(context.supabase, context.orgId, [row])
  return enrichDetail(context, message, row)
}

// ── Ruling on what a message is ─────────────────────────────────────────────

/**
 * Files a message's attachments where the classification says they belong.
 *
 * Everything arrives as `other` under `/correspondence`, because at ingest
 * nobody knows yet what the message is. Once that is decided, a shop drawing
 * emailed by a sub should be findable from Submittals rather than only from the
 * mail it rode in on.
 */
export async function applyAttachmentCategory(orgId: string, emailIds: string[], classification: CorrespondenceClassification) {
  const category = CLASSIFICATION_FILE_CATEGORIES[classification]
  if (!category || !emailIds.length) return
  const supabase = createServiceSupabaseClient()
  const fileIds: string[] = []
  for (const batch of chunk(emailIds)) {
    const { data } = await supabase
      .from("file_links")
      .select("file_id")
      .eq("org_id", orgId)
      .eq("entity_type", "project_email")
      .in("entity_id", batch)
    for (const row of data ?? []) if (row.file_id) fileIds.push(String(row.file_id))
  }
  for (const batch of chunk(fileIds)) {
    await supabase.from("files").update({ category }).eq("org_id", orgId).in("id", batch)
  }
}

/**
 * A selection is threads, messages, or both; every ruling is per message.
 * Archived messages inside a selected thread are left alone — the thread the
 * user was looking at did not contain them.
 */
async function resolveSelection(
  context: OrgServiceContext,
  projectId: string,
  selection: { emailIds: string[]; threadIds: string[] },
): Promise<string[]> {
  const ids = new Set(selection.emailIds)
  for (const batch of chunk(selection.threadIds)) {
    const { data, error } = await context.supabase
      .from("project_emails")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .in("thread_id", batch)
      .is("archived_at", null)
    if (error) throw new Error(`Failed to resolve the selection: ${error.message}`)
    for (const row of data ?? []) ids.add(String(row.id))
  }
  if (!ids.size) throw new Error("Those messages are no longer in this project's log.")
  return [...ids]
}

async function readMessages(
  context: OrgServiceContext,
  projectId: string,
  emailIds: string[],
): Promise<CorrespondenceMessage[]> {
  const rows: Record<string, unknown>[] = []
  for (const batch of chunk(emailIds)) {
    const { data, error } = await context.supabase
      .from("project_emails")
      .select(EMAIL_SELECT)
      .eq("org_id", context.orgId)
      .eq("project_id", projectId)
      .in("id", batch)
    if (error) throw new Error(`Failed to read correspondence: ${error.message}`)
    rows.push(...((data ?? []) as Record<string, unknown>[]))
  }
  return hydrateMessages(context.supabase, context.orgId, rows)
}

/**
 * Human override of the model's guess. The log is quasi-evidentiary, so a
 * person always outranks the model — and the row records which of the two
 * decided. Bulk by construction: the triage queue is the main way this is used.
 */
export async function reclassifyProjectEmails(
  input: {
    projectId: string
    emailIds?: string[]
    threadIds?: string[]
    classification: CorrespondenceClassification
  },
  orgId?: string,
): Promise<CorrespondenceMessage[]> {
  const parsed = reclassifySchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.write")
  const selected = await resolveSelection(context, parsed.projectId, parsed)

  const updatedIds: string[] = []
  for (const batch of chunk(selected)) {
    const { data, error } = await context.supabase
      .from("project_emails")
      .update({ classification: parsed.classification, classified_by: "user", classification_confidence: null })
      .eq("org_id", context.orgId)
      .eq("project_id", parsed.projectId)
      .in("id", batch)
      .select("id")
    if (error) throw new Error(`Failed to reclassify: ${error.message}`)
    for (const row of data ?? []) updatedIds.push(String(row.id))
  }
  if (!updatedIds.length) throw new Error("Those messages are no longer in this project's log.")

  await applyAttachmentCategory(context.orgId, updatedIds, parsed.classification)
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: "project_email_reclassified",
      entityType: "project",
      entityId: parsed.projectId,
      payload: { project_id: parsed.projectId, classification: parsed.classification, email_count: updatedIds.length },
    }),
    ...updatedIds.map((emailId) =>
      recordAudit({
        orgId: context.orgId,
        action: "update",
        entityType: "project_email",
        entityId: emailId,
        after: { classification: parsed.classification, classified_by: "user" },
        source: "correspondence",
      }),
    ),
  ])
  return readMessages(context, parsed.projectId, updatedIds)
}

/**
 * Ratifies the model's guess without changing it.
 *
 * There was no way to do this: the only reclassify path was a select's change
 * handler, which does not fire when you pick the value that is already
 * selected. A message the model rated at 62% could never be promoted to a human
 * ruling without first setting it to something wrong.
 */
export async function confirmProjectEmailClassifications(
  input: { projectId: string; emailIds?: string[]; threadIds?: string[] },
  orgId?: string,
): Promise<CorrespondenceMessage[]> {
  const parsed = confirmClassificationSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.write")
  const selected = await resolveSelection(context, parsed.projectId, parsed)

  const rows: Array<{ id: string; classification: string }> = []
  for (const batch of chunk(selected)) {
    const { data, error } = await context.supabase
      .from("project_emails")
      .update({ classified_by: "user", classification_confidence: null })
      .eq("org_id", context.orgId)
      .eq("project_id", parsed.projectId)
      .in("id", batch)
      .select("id,classification")
    if (error) throw new Error(`Failed to confirm: ${error.message}`)
    for (const row of data ?? []) rows.push({ id: String(row.id), classification: String(row.classification) })
  }
  if (!rows.length) throw new Error("Those messages are no longer in this project's log.")

  // Confirming is also the moment a classification becomes trustworthy enough
  // to file the attachments by.
  const byClassification = new Map<CorrespondenceClassification, string[]>()
  for (const row of rows) {
    const value = String(row.classification)
    if (!isCorrespondenceClassification(value)) continue
    byClassification.set(value, [...(byClassification.get(value) ?? []), String(row.id)])
  }
  await Promise.all(
    [...byClassification.entries()].map(([classification, ids]) =>
      applyAttachmentCategory(context.orgId, ids, classification),
    ),
  )

  const ids = rows.map((row) => String(row.id))
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: "project_email_classification_confirmed",
      entityType: "project",
      entityId: parsed.projectId,
      payload: { project_id: parsed.projectId, email_count: ids.length },
    }),
    ...ids.map((emailId) =>
      recordAudit({
        orgId: context.orgId,
        action: "update",
        entityType: "project_email",
        entityId: emailId,
        after: { classified_by: "user" },
        source: "correspondence",
      }),
    ),
  ])
  return readMessages(context, parsed.projectId, ids)
}

/**
 * Unfiles a message, or puts it back.
 *
 * The inbound address is an unauthenticated write into the project record, so
 * spam and mis-sent mail land in the log and used to stay there permanently.
 * The row survives — a log you can delete from is not a record — but it leaves
 * the working view.
 */
export async function archiveProjectEmails(
  input: { projectId: string; emailIds?: string[]; threadIds?: string[]; archived: boolean },
  orgId?: string,
): Promise<CorrespondenceMessage[]> {
  const parsed = archiveSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.write")
  // Restoring works off explicit message ids: an archived message is not in any
  // thread the list can offer, so there is nothing to resolve.
  const selected = parsed.archived
    ? await resolveSelection(context, parsed.projectId, parsed)
    : parsed.emailIds
  if (!selected.length) throw new Error("Select at least one message.")

  const patch = parsed.archived
    ? { archived_at: new Date().toISOString(), archived_by: context.userId }
    : { archived_at: null, archived_by: null }

  const ids: string[] = []
  for (const batch of chunk(selected)) {
    const { data, error } = await context.supabase
      .from("project_emails")
      .update(patch)
      .eq("org_id", context.orgId)
      .eq("project_id", parsed.projectId)
      .in("id", batch)
      .select("id")
    if (error) throw new Error(`Failed to update the log: ${error.message}`)
    for (const row of data ?? []) ids.push(String(row.id))
  }
  if (!ids.length) throw new Error("Those messages are no longer in this project's log.")

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      eventType: parsed.archived ? "project_email_archived" : "project_email_restored",
      entityType: "project",
      entityId: parsed.projectId,
      payload: { project_id: parsed.projectId, email_count: ids.length },
    }),
    ...ids.map((emailId) =>
      recordAudit({
        orgId: context.orgId,
        action: "update",
        entityType: "project_email",
        entityId: emailId,
        after: patch,
        source: "correspondence",
      }),
    ),
  ])
  return readMessages(context, parsed.projectId, ids)
}

// ── What a message is about ─────────────────────────────────────────────────

/**
 * Attaches a message to a record that already exists.
 *
 * A message can carry more than one link: an answer that also prices a change
 * belongs to both the RFI and the change event. When nobody has ruled on the
 * classification yet, the link decides it — a person choosing the RFI has said
 * what the mail is about more precisely than the model could.
 */
export async function linkProjectEmail(
  input: { projectId: string; emailId: string; entityType: LinkableEntityType; entityId: string },
  orgId?: string,
): Promise<CorrespondenceMessage> {
  const parsed = linkSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.write")
  await requirePermission(LINKABLE_ENTITY_PERMISSIONS[parsed.entityType], context)

  const { data: email } = await context.supabase
    .from("project_emails")
    .select("id,classified_by")
    .eq("org_id", context.orgId)
    .eq("project_id", parsed.projectId)
    .eq("id", parsed.emailId)
    .maybeSingle()
  if (!email) throw new Error("That email is no longer in this project's log.")

  const { error } = await context.supabase.from("project_email_links").insert({
    org_id: context.orgId,
    project_id: parsed.projectId,
    project_email_id: parsed.emailId,
    entity_type: parsed.entityType,
    entity_id: parsed.entityId,
    created_by: context.userId,
  })
  // 23505 is the row already existing, which is the outcome the caller wanted.
  if (error && error.code !== "23505") throw new Error(`Failed to link: ${error.message}`)

  if (email.classified_by !== "user") {
    const classification = LINK_IMPLIED_CLASSIFICATION[parsed.entityType]
    await context.supabase
      .from("project_emails")
      .update({ classification, classified_by: "user", classification_confidence: null })
      .eq("org_id", context.orgId)
      .eq("project_id", parsed.projectId)
      .eq("id", parsed.emailId)
    await applyAttachmentCategory(context.orgId, [parsed.emailId], classification)
  }

  await recordAudit({
    orgId: context.orgId,
    action: "insert",
    entityType: "project_email",
    entityId: parsed.emailId,
    after: { entity_type: parsed.entityType, entity_id: parsed.entityId },
    source: "correspondence",
  })
  const [message] = await readMessages(context, parsed.projectId, [parsed.emailId])
  return message
}

/** Detaches a bad link. The linked record itself is left alone. */
export async function unlinkProjectEmail(
  input: { projectId: string; emailId: string; linkId: string },
  orgId?: string,
): Promise<CorrespondenceMessage> {
  const parsed = unlinkSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.write")

  const { error } = await context.supabase
    .from("project_email_links")
    .delete()
    .eq("org_id", context.orgId)
    .eq("project_email_id", parsed.emailId)
    .eq("id", parsed.linkId)
  if (error) throw new Error(`Failed to remove the link: ${error.message}`)

  await recordAudit({
    orgId: context.orgId,
    action: "delete",
    entityType: "project_email",
    entityId: parsed.emailId,
    after: { link_id: parsed.linkId },
    source: "correspondence",
  })
  const [message] = await readMessages(context, parsed.projectId, [parsed.emailId])
  return message
}

/** Records of one kind a message can be attached to, for the link picker. */
export async function listCorrespondenceLinkTargets(
  input: { projectId: string; entityType: LinkableEntityType; search?: string },
  orgId?: string,
): Promise<LinkTarget[]> {
  const parsed = linkTargetSearchSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, parsed.projectId, "correspondence.read")

  const needle = parsed.search?.toLowerCase() ?? ""
  const matches = (label: string, sublabel: string | null) =>
    !needle || `${label} ${sublabel ?? ""}`.toLowerCase().includes(needle)

  switch (parsed.entityType) {
    case "change_event": {
      const events = await listChangeEvents(parsed.projectId, context.orgId)
      return events
        .map((event) => ({ id: event.id, label: `CE-${event.event_number} · ${event.title}`, sublabel: event.status }))
        .filter((target) => matches(target.label, target.sublabel))
    }
    case "rfi": {
      const rfis = await listRfis(context.orgId, parsed.projectId)
      return rfis
        .map((rfi) => ({ id: rfi.id, label: `RFI-${rfi.rfi_number} · ${rfi.subject}`, sublabel: rfi.status }))
        .filter((target) => matches(target.label, target.sublabel))
    }
    case "submittal": {
      const submittals = await listSubmittals(context.orgId, parsed.projectId)
      return submittals
        .map((submittal) => ({
          id: submittal.id,
          label: `${submittal.submittal_number ?? "Submittal"} · ${submittal.title}`,
          sublabel: submittal.status,
        }))
        .filter((target) => matches(target.label, target.sublabel))
    }
    case "vendor_bill": {
      const bills = await listVendorBillsForProject(parsed.projectId, context.orgId)
      return bills
        .map((bill) => ({
          id: bill.id,
          label: `${bill.bill_number ?? "Bill"} · ${bill.company_name ?? "Unknown vendor"}`,
          sublabel: bill.status,
        }))
        .filter((target) => matches(target.label, target.sublabel))
    }
  }
}
