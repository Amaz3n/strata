/**
 * Inbound project mail.
 *
 * Anything sent or BCC'd to `project-<slug>@$PAYABLES_INBOUND_DOMAIN` lands
 * here: the webhook enqueues an outbox job, this drains it — fetch the message
 * and its attachments from Resend, file both against the project, attribute the
 * counterparty to the directory, and queue the classifier.
 *
 * The workbench half — reading, ruling, linking, sending — lives in
 * `lib/services/correspondence.ts`. This module imports from it and never the
 * other way around.
 */

import { createHash } from "node:crypto"
import { z } from "zod"

import {
  CORRESPONDENCE_CLASSIFICATIONS,
  isCorrespondenceClassification,
  type CorrespondenceClassification,
  type CorrespondenceDirection,
} from "@/lib/correspondence"
import { runAiObject } from "@/lib/services/ai/gateway"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { createSystemChangeEvent } from "@/lib/services/change-events"
import {
  applyAttachmentCategory,
  bareAddress,
  bodySnippet,
  inboundSlugsFromRecipients,
  loadBody,
  persistBodyFile,
  resolvePartyForAddress,
  resolveThreadId,
} from "@/lib/services/correspondence"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { NotificationService } from "@/lib/services/notifications"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { processInboundBillEmail } from "@/lib/services/payables-email-ingest"

const RESEND_API_BASE = "https://api.resend.com"

interface ReceivedEmail {
  id: string
  from: string
  to: string[] | string
  cc?: string[] | string
  subject?: string | null
  text?: string | null
  html?: string | null
  message_id?: string | null
  /** RFC 5322 threading headers, when the provider surfaces them. */
  in_reply_to?: string | null
  references?: string[] | string | null
  headers?: Record<string, string> | null
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

/** Attachments filed from one message, so a bulk send cannot flood storage. */
const MAX_ATTACHMENTS = 25

async function resendGet<T>(path: string): Promise<T> {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error("RESEND_API_KEY is not configured")
  const response = await fetch(`${RESEND_API_BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } })
  if (!response.ok) throw new Error(`Resend API failed: ${response.status}`)
  return response.json() as Promise<T>
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

/** Header lookup that does not care how the provider cased the name. */
function header(email: ReceivedEmail, name: string): string | null {
  const headers = email.headers ?? {}
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : null
}

/** `<a@x> <b@y>` or an array, depending on the provider — normalise to a list. */
function messageIdList(value: string[] | string | null | undefined): string[] {
  if (!value) return []
  const raw = Array.isArray(value) ? value.join(" ") : value
  return raw.match(/<[^>]+>/g) ?? []
}

export async function findProjectByInboundRecipients(recipients: string[]) {
  const slugs = inboundSlugsFromRecipients(recipients)
  if (!slugs.length) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("projects")
    .select("id,org_id,correspondence_slug")
    .in("correspondence_slug", slugs)
    .limit(1)
    .maybeSingle()
  return data
    ? { projectId: data.id as string, orgId: data.org_id as string, slug: data.correspondence_slug as string }
    : null
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
  const mimeType = input.attachment.content_type ?? "application/octet-stream"
  await uploadFilesObject({
    supabase,
    orgId: input.orgId,
    path: storagePath,
    bytes,
    contentType: mimeType,
    upsert: false,
  })
  const { data, error } = await supabase
    .from("files")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      file_name: safeName,
      storage_path: storagePath,
      mime_type: mimeType,
      size_bytes: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      visibility: "private",
      // A photo is a photo whatever the message turns out to be; everything else
      // waits for the classification to say where it belongs.
      category: mimeType.startsWith("image/") ? "photos" : "other",
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

  const to = Array.isArray(email.to) ? email.to : [email.to]
  const cc = !email.cc ? [] : Array.isArray(email.cc) ? email.cc : [email.cc]
  const messageId = email.message_id ?? email.id
  const inReplyTo = messageIdList(email.in_reply_to ?? header(email, "in-reply-to"))[0] ?? null
  const references = messageIdList(email.references ?? header(email, "references"))
  const subject = email.subject?.trim() || "(No subject)"

  const threadId = await resolveThreadId({
    supabase,
    orgId: input.orgId,
    projectId: input.projectId,
    subject,
    inReplyTo,
    references,
  })

  const fromAddress = bareAddress(email.from)
  const members = await orgMemberAddresses(input.orgId)
  const direction: CorrespondenceDirection = members.has(fromAddress) ? "outbound" : "inbound"
  const toAddresses = to.map(bareAddress)
  // The far side of the message from the builder, which is the party the
  // directory should attribute this to.
  const counterparty = direction === "inbound" ? fromAddress : (toAddresses[0] ?? fromAddress)
  const party = await resolvePartyForAddress(supabase, input.orgId, counterparty)

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
    in_reply_to: inReplyTo,
    reference_ids: references,
    from_address: fromAddress,
    to_addresses: toAddresses,
    cc_addresses: cc.map(bareAddress),
    subject,
    body_preview: bodySnippet(body),
    contact_id: party.contactId,
    company_id: party.companyId,
    classification: "general",
    // Filed, and nobody has ruled on it yet. This is what the triage queue and
    // the nav badge count.
    classified_by: "system",
    received_at: receivedAt,
    sent_at: sentAt,
  }
  const { data, error } = await supabase.from("project_emails").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to file project email: ${error?.message}`)

  const bodyFileId = await persistBodyFile({ ...input, emailId: data.id, body })
  await supabase.from("project_emails").update({ body_file_id: bodyFileId }).eq("id", data.id)

  const attachments = await resendGet<{ data: ReceivedAttachment[] }>(
    `/emails/receiving/${encodeURIComponent(input.emailId)}/attachments`,
  )
  const attachmentIds = await Promise.all(
    (attachments.data ?? [])
      .slice(0, MAX_ATTACHMENTS)
      .map((attachment) => persistAttachment({ ...input, emailId: data.id, attachment })),
  )

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

/** Above this the classifier acts on its own; below it a person decides. */
const AUTO_ACTION_CONFIDENCE = 0.75

/**
 * Tells the project the mail said something changed.
 *
 * The auto-created change event used to appear with nobody informed — the one
 * classification that means somebody has to act was the one nobody heard about
 * until they next opened the tab.
 */
async function notifyChangeTrigger(input: {
  orgId: string
  projectId: string
  emailId: string
  subject: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: members } = await supabase
    .from("project_members")
    .select("user_id")
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("status", "active")

  const notifications = new NotificationService()
  const seen = new Set<string>()
  for (const member of members ?? []) {
    const userId = member.user_id as string
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    await notifications
      .createAndQueue({
        orgId: input.orgId,
        userId,
        type: "project_email_change_trigger",
        title: "Email may be a change",
        message: input.subject,
        projectId: input.projectId,
        entityType: "project_email",
        entityId: input.emailId,
        metadata: { href: `/projects/${input.projectId}/correspondence?email=${input.emailId}` },
      })
      .catch((error) => console.error("correspondence: change-trigger notification failed", error))
  }
}

export async function classifyProjectEmail(input: { orgId: string; projectEmailId: string; body?: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: email, error } = await supabase
    .from("project_emails")
    .select("id,project_id,provider_email_id,subject,from_address,classification,classified_by,body_file_id")
    .eq("org_id", input.orgId)
    .eq("id", input.projectEmailId)
    .maybeSingle()
  if (error || !email) throw new Error("Project email not found")

  // A person already ruled on this one; the model does not get to overwrite them.
  const current = String(email.classification ?? "general")
  if (email.classified_by === "user") {
    return { classification: isCorrespondenceClassification(current) ? current : "general", confidence: null }
  }

  if (!(await isAiSearchEnabledForOrg({ supabase, orgId: input.orgId }))) {
    return { classification: "general" as CorrespondenceClassification, confidence: null }
  }

  // The outbox payload carries the body, but a retry after the payload was
  // trimmed still has the stored file to fall back on.
  const body = input.body ?? (await loadBody(input.orgId, (email.body_file_id as string | null) ?? null)).body

  const result = await runAiObject({
    feature: "document_extraction",
    schema: classificationSchema,
    system: CLASSIFY_PROMPT,
    prompt: `Subject: ${email.subject}\nFrom: ${email.from_address}\nBody: ${body.slice(0, 20_000)}`,
    orgId: input.orgId,
    entityType: "project_email",
    entityId: input.projectEmailId,
    timeoutMs: 60_000,
    allowEscalation: false,
  })
  // A failed classification leaves the row untouched, so `classified_by` stays
  // honest rather than stamping an unclassified row as AI-rated.
  if (!result.ok) return { classification: "general" as CorrespondenceClassification, confidence: null }
  const classification = result.object

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

  // Confident enough to act on is confident enough to file the attachments by.
  if (classification.confidence >= AUTO_ACTION_CONFIDENCE) {
    await applyAttachmentCategory(input.orgId, [String(email.id)], classification.classification)
  }

  if (classification.classification === "co_trigger" && classification.confidence >= AUTO_ACTION_CONFIDENCE) {
    const { data: existingLink } = await supabase
      .from("project_email_links")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("project_email_id", email.id)
      .eq("entity_type", "change_event")
      .maybeSingle()
    if (!existingLink) {
      const event = await createSystemChangeEvent({
        orgId: input.orgId,
        projectId: email.project_id,
        title: email.subject,
        description: body || null,
        originType: "email",
        originId: email.id,
      })
      await supabase.from("project_email_links").insert({
        org_id: input.orgId,
        project_id: email.project_id,
        project_email_id: email.id,
        entity_type: "change_event",
        entity_id: event.id,
      })
      await notifyChangeTrigger({
        orgId: input.orgId,
        projectId: String(email.project_id),
        emailId: String(email.id),
        subject: String(email.subject),
      })
    }
  }
  if (classification.classification === "bill" && classification.confidence >= AUTO_ACTION_CONFIDENCE) {
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
