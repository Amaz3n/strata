import { createHash } from "node:crypto"
import { generateText } from "ai"
import { z } from "zod"

import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { createSystemChangeEvent } from "@/lib/services/change-events"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { requireOrgContext } from "@/lib/services/context"
import { requireProjectPermission } from "@/lib/services/permissions"
import { processInboundBillEmail } from "@/lib/services/payables-email-ingest"

const RESEND_API_BASE = "https://api.resend.com"
const PROJECT_PREFIX = "project-"

interface ReceivedEmail {
  id: string
  from: string
  to: string[] | string
  cc?: string[] | string
  subject?: string | null
  text?: string | null
  html?: string | null
  message_id?: string | null
}

interface ReceivedAttachment { id: string; filename: string; content_type?: string | null; size?: number | null; download_url: string }

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

export async function findProjectByInboundRecipients(recipients: string[]) {
  const slugs = recipients.map(localPart).filter((value) => value.startsWith(PROJECT_PREFIX)).map((value) => value.slice(PROJECT_PREFIX.length)).filter(Boolean)
  if (!slugs.length) return null
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("projects").select("id,org_id,correspondence_slug").in("correspondence_slug", slugs).limit(1).maybeSingle()
  return data ? { projectId: data.id, orgId: data.org_id, slug: data.correspondence_slug } : null
}

export function projectInboundAddress(slug: string) {
  const domain = process.env.PAYABLES_INBOUND_DOMAIN
  return domain ? `${PROJECT_PREFIX}${slug}@${domain}` : null
}

export async function listProjectCorrespondence(projectId: string, filters: { classification?: string; search?: string } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireProjectPermission(context.userId, projectId, "correspondence.read")
  let query = context.supabase.from("project_emails").select("id,direction,thread_id,from_address,to_addresses,cc_addresses,subject,classification,classified_by,classification_confidence,linked_entity_type,linked_entity_id,received_at,sent_at,created_at").eq("org_id", context.orgId).eq("project_id", projectId).order("received_at", { ascending: false, nullsFirst: false }).limit(250)
  if (filters.classification) query = query.eq("classification", filters.classification)
  if (filters.search) query = query.ilike("subject", `%${filters.search.replace(/[%,]/g, "")}%`)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load correspondence: ${error.message}`)
  return data ?? []
}

async function persistBodyFile(input: { orgId: string; projectId: string; emailId: string; body: string }) {
  const supabase = createServiceSupabaseClient()
  const bytes = Buffer.from(input.body, "utf8")
  const storagePath = `${input.orgId}/${input.projectId}/correspondence/${input.emailId}/body.txt`
  await uploadFilesObject({ supabase, orgId: input.orgId, path: storagePath, bytes, contentType: "text/plain", upsert: true })
  const { data: existing } = await supabase.from("files").select("id").eq("org_id", input.orgId).eq("project_id", input.projectId).eq("storage_path", storagePath).maybeSingle()
  if (existing) return existing.id
  const { data, error } = await supabase.from("files").insert({ org_id: input.orgId, project_id: input.projectId, file_name: "email-body.txt", storage_path: storagePath, mime_type: "text/plain", size_bytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), visibility: "private", category: "other", folder_path: "/correspondence", source: "email" }).select("id").single()
  if (error || !data) throw new Error(`Failed to store email body: ${error?.message}`)
  return data.id
}

async function persistAttachment(input: { orgId: string; projectId: string; emailId: string; attachment: ReceivedAttachment }) {
  const response = await fetch(input.attachment.download_url)
  if (!response.ok) throw new Error(`Failed to download email attachment: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const safeName = input.attachment.filename.replace(/[/\\]/g, "-") || "attachment"
  const storagePath = `${input.orgId}/${input.projectId}/correspondence/${input.emailId}/${crypto.randomUUID()}-${safeName}`
  const supabase = createServiceSupabaseClient()
  await uploadFilesObject({ supabase, orgId: input.orgId, path: storagePath, bytes, contentType: input.attachment.content_type ?? "application/octet-stream", upsert: false })
  const { data, error } = await supabase.from("files").insert({ org_id: input.orgId, project_id: input.projectId, file_name: safeName, storage_path: storagePath, mime_type: input.attachment.content_type ?? "application/octet-stream", size_bytes: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), visibility: "private", category: "other", folder_path: "/correspondence", source: "email" }).select("id").single()
  if (error || !data) throw new Error(`Failed to store email attachment: ${error?.message}`)
  return data.id
}

export async function processInboundProjectEmail(input: { orgId: string; projectId: string; emailId: string }) {
  const supabase = createServiceSupabaseClient()
  const email = await resendGet<ReceivedEmail>(`/emails/receiving/${encodeURIComponent(input.emailId)}`)
  const { data: duplicate } = await supabase.from("project_emails").select("id").eq("org_id", input.orgId).eq("message_id", email.message_id ?? email.id).maybeSingle()
  if (duplicate) return duplicate
  const body = email.text?.trim() || email.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "(No message body)"
  const bodyFileId = await persistBodyFile({ ...input, body })
  const attachments = await resendGet<{ data: ReceivedAttachment[] }>(`/emails/receiving/${encodeURIComponent(input.emailId)}/attachments`)
  const attachmentIds = await Promise.all((attachments.data ?? []).slice(0, 25).map((attachment) => persistAttachment({ ...input, attachment })))
  const to = Array.isArray(email.to) ? email.to : [email.to]
  const cc = !email.cc ? [] : Array.isArray(email.cc) ? email.cc : [email.cc]
  const messageId = email.message_id ?? email.id
  const threadId = createHash("sha256").update(`${input.projectId}:${(email.subject ?? "").replace(/^(re|fwd?):\s*/i, "").toLowerCase()}`).digest("hex")
  const payload = { org_id: input.orgId, project_id: input.projectId, direction: "inbound", message_id: messageId, provider_email_id: input.emailId, thread_id: threadId, from_address: bareAddress(email.from), to_addresses: to.map(bareAddress), cc_addresses: cc.map(bareAddress), subject: email.subject?.trim() || "(No subject)", body_file_id: bodyFileId, classification: "general", classified_by: "user", received_at: new Date().toISOString() }
  const { data, error } = await supabase.from("project_emails").insert(payload).select("*").single()
  if (error || !data) throw new Error(`Failed to file project email: ${error?.message}`)
  if (attachmentIds.length) {
    const { error: linkError } = await supabase.from("file_links").insert(attachmentIds.map((fileId) => ({ org_id: input.orgId, project_id: input.projectId, file_id: fileId, entity_type: "project_email", entity_id: data.id, link_role: "attachment" })))
    if (linkError) throw new Error(`Failed to link email attachments: ${linkError.message}`)
  }
  await enqueueOutboxJob({ orgId: input.orgId, jobType: "classify_project_email", payload: { project_email_id: data.id, body }, dedupeByPayloadKeys: ["project_email_id"] })
  await Promise.all([
    recordEvent({ orgId: input.orgId, eventType: "project_email_received", entityType: "project_email", entityId: data.id, payload: { project_id: input.projectId, subject: payload.subject, attachment_count: attachmentIds.length } }),
    recordAudit({ orgId: input.orgId, action: "insert", entityType: "project_email", entityId: data.id, after: payload, source: "resend_inbound" }),
  ])
  return data
}

const classificationSchema = z.object({ classification: z.enum(["correspondence","rfi_related","co_trigger","bill","submittal_related","general"]), confidence: z.number().min(0).max(1) })

export async function classifyProjectEmail(input: { orgId: string; projectEmailId: string; body?: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: email, error } = await supabase.from("project_emails").select("id,project_id,provider_email_id,subject,from_address,classification").eq("org_id", input.orgId).eq("id", input.projectEmailId).maybeSingle()
  if (error || !email) throw new Error("Project email not found")
  let classification = { classification: "general", confidence: 0 } as z.infer<typeof classificationSchema>
  if (await isAiSearchEnabledForOrg({ supabase, orgId: input.orgId })) {
    const config = await getPlatformAiFeatureDefaultConfig({ supabase, feature: "document_extraction" })
    const key = getApiKeyForProvider(config.provider)
    if (key) {
      const result = await generateText({ model: resolveLanguageModel(config.provider, key, config.model), prompt: `Classify this construction project email. Return JSON only: {"classification":"correspondence|rfi_related|co_trigger|bill|submittal_related|general","confidence":0..1}. co_trigger means a credible scope/cost/schedule change, not merely discussion.\nSubject: ${email.subject}\nFrom: ${email.from_address}\nBody: ${(input.body ?? "").slice(0, 20_000)}`, abortSignal: AbortSignal.timeout(60_000) })
      classification = classificationSchema.parse(JSON.parse(result.text.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()))
    }
  }
  const { error: updateError } = await supabase.from("project_emails").update({ classification: classification.classification, classified_by: "ai", classification_confidence: classification.confidence }).eq("org_id", input.orgId).eq("id", input.projectEmailId)
  if (updateError) throw new Error(`Failed to classify project email: ${updateError.message}`)
  if (classification.classification === "co_trigger" && classification.confidence >= 0.75) {
    const event = await createSystemChangeEvent({ orgId: input.orgId, projectId: email.project_id, title: email.subject, description: input.body ?? null, originType: "email", originId: email.id })
    await supabase.from("project_emails").update({ linked_entity_type: "change_event", linked_entity_id: event.id }).eq("org_id", input.orgId).eq("id", input.projectEmailId)
  }
  if (classification.classification === "bill" && classification.confidence >= 0.75) {
    if (email.provider_email_id) await processInboundBillEmail({ orgId: input.orgId, emailId: email.provider_email_id, preferredProjectId: email.project_id })
    await recordEvent({ orgId: input.orgId, eventType: "project_email_bill_detected", entityType: "project_email", entityId: email.id, payload: { project_id: email.project_id, routed_to_ap_ingest: Boolean(email.provider_email_id) } })
  }
  return classification
}
