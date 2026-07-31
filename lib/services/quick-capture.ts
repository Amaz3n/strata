import type { SupabaseClient } from "@supabase/supabase-js"
import { generateText } from "ai"

import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { transcribeConstructionAudio } from "@/lib/services/meeting-transcripts"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { createTask } from "@/lib/services/tasks"
import { createRfi } from "@/lib/services/rfis"
import { createObservation } from "@/lib/services/safety"
import {
  quickCaptureExtractedPayloadSchema,
  quickCaptureInputSchema,
  type QuickCaptureExtractedPayload,
  type QuickCaptureInput,
} from "@/lib/validation/quick-capture"

export interface QuickCaptureActorContext {
  supabase: SupabaseClient
  orgId: string
  userId: string
}

const DRAFT_SELECT = "id,org_id,project_id,lot_id,capture_kind,target_type,status,source_file_id,attachment_file_ids,transcript,extracted_payload,confidence,failure_reason,created_by,committed_entity_type,committed_entity_id,created_at,updated_at"

export async function queueQuickCaptureForActor(input: QuickCaptureInput, actor: QuickCaptureActorContext) {
  const parsed = quickCaptureInputSchema.parse(input)
  await requireAuthorization({ permission: "quick_capture.create", userId: actor.userId, orgId: actor.orgId, projectId: parsed.project_id, supabase: actor.supabase, logDecision: true, resourceType: "project", resourceId: parsed.project_id })
  const fileIds = [parsed.source_file_id, ...parsed.attachment_file_ids].filter((id): id is string => Boolean(id))
  if (fileIds.length) {
    const { data: files, error } = await actor.supabase.from("files").select("id").eq("org_id", actor.orgId).eq("project_id", parsed.project_id).in("id", fileIds)
    if (error || files?.length !== new Set(fileIds).size) throw new Error("Every capture attachment must belong to this project")
  }
  const { data, error } = await actor.supabase.from("quick_capture_drafts").insert({
    org_id: actor.orgId, project_id: parsed.project_id, lot_id: parsed.lot_id ?? null,
    capture_kind: parsed.capture_kind, target_type: parsed.preferred_target ?? null,
    status: "queued", source_file_id: parsed.source_file_id ?? null,
    attachment_file_ids: parsed.attachment_file_ids, transcript: parsed.transcript ?? null,
    extracted_payload: parsed.preferred_target ? { preferred_target: parsed.preferred_target } : {}, created_by: actor.userId,
  }).select(DRAFT_SELECT).single()
  if (error || !data) throw new Error(`Failed to queue quick capture: ${error?.message}`)
  await enqueueOutboxJob({ orgId: actor.orgId, jobType: "process_quick_capture", payload: { draft_id: data.id }, dedupeByPayloadKeys: ["draft_id"] })
  await Promise.all([
    recordEvent({ orgId: actor.orgId, actorId: actor.userId, eventType: "quick_capture_queued", entityType: "quick_capture_draft", entityId: data.id, payload: { project_id: parsed.project_id, capture_kind: parsed.capture_kind } }),
    recordAudit({ orgId: actor.orgId, actorId: actor.userId, action: "insert", entityType: "quick_capture_draft", entityId: data.id, after: data }),
  ])
  return data
}

export async function queueQuickCapture(input: QuickCaptureInput, orgId?: string) {
  const context = await requireOrgContext(orgId)
  return queueQuickCaptureForActor(input, { supabase: context.supabase, orgId: context.orgId, userId: context.userId })
}

function jsonCandidate(raw: string) {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
}

async function extractDraft(transcript: string, preferredTarget: string | null): Promise<QuickCaptureExtractedPayload> {
  const serviceClient = createServiceSupabaseClient()
  const config = await getPlatformAiFeatureDefaultConfig({ supabase: serviceClient, feature: "document_extraction" })
  const key = getApiKeyForProvider(config.provider)
  if (!key) throw new Error(`${config.provider} is not configured for quick capture`)
  const prompt = `Turn this construction field note into ONE typed draft. Return JSON only with: target_type (punch_item|observation|daily_log_note|task|rfi_draft), title, description, location (string|null), due_date (YYYY-MM-DD|null), priority (low|normal|high|urgent), observation_kind (safety|quality|null), observation_category (positive|at_risk|deficiency|null), confidence (0..1). Never invent names, dates, or locations. ${preferredTarget ? `Prefer ${preferredTarget} unless clearly wrong.` : ""}\n\nFIELD NOTE:\n${transcript}`
  let lastError = "Invalid structured response"
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generateText({ model: resolveLanguageModel(config.provider, key, config.model), prompt: attempt ? `${prompt}\nReturn only schema-compliant JSON.` : prompt, abortSignal: AbortSignal.timeout(90_000) })
    try { return quickCaptureExtractedPayloadSchema.parse(JSON.parse(jsonCandidate(result.text))) } catch (error) { lastError = error instanceof Error ? error.message : lastError }
  }
  throw new Error(`Quick-capture extraction failed validation: ${lastError}`)
}

export async function processQuickCaptureDraft(draftId: string, orgId: string) {
  const serviceClient = createServiceSupabaseClient()
  const enabled = await isAiSearchEnabledForOrg({ supabase: serviceClient, orgId })
  if (!enabled) throw new Error("AI features are disabled for this organization")
  const { data: draft, error } = await serviceClient.from("quick_capture_drafts").select(`${DRAFT_SELECT},source_file:files!quick_capture_drafts_source_file_id_fkey(storage_path,mime_type,file_name)`).eq("org_id", orgId).eq("id", draftId).maybeSingle()
  if (error || !draft) throw new Error("Quick-capture draft not found")
  if (draft.status === "ready" || draft.status === "committed" || draft.status === "rejected") return draft
  await serviceClient.from("quick_capture_drafts").update({ status: "processing", failure_reason: null }).eq("org_id", orgId).eq("id", draftId)
  try {
    let transcript = typeof draft.transcript === "string" ? draft.transcript.trim() : ""
    if (!transcript && draft.source_file_id) {
      const file = Array.isArray(draft.source_file) ? draft.source_file[0] : draft.source_file
      if (!file?.storage_path) throw new Error("Capture media is unavailable")
      const bytes = await downloadFilesObject({ supabase: serviceClient, orgId, path: file.storage_path })
      transcript = await transcribeConstructionAudio(bytes, file.mime_type ?? "audio/webm", file.file_name ?? "capture.webm")
    }
    if (!transcript) throw new Error("Capture has no transcript")
    const preferred = draft.extracted_payload && typeof draft.extracted_payload === "object" && !Array.isArray(draft.extracted_payload) && typeof draft.extracted_payload.preferred_target === "string" ? draft.extracted_payload.preferred_target : null
    const extracted = await extractDraft(transcript, preferred)
    const { data, error: updateError } = await serviceClient.from("quick_capture_drafts").update({ status: "ready", target_type: extracted.target_type, transcript, extracted_payload: extracted, confidence: extracted.confidence }).eq("org_id", orgId).eq("id", draftId).select(DRAFT_SELECT).single()
    if (updateError || !data) throw new Error(`Failed to save quick-capture draft: ${updateError?.message}`)
    await recordEvent({ orgId, actorId: draft.created_by, eventType: "quick_capture_ready", entityType: "quick_capture_draft", entityId: draftId, payload: { project_id: draft.project_id, target_type: extracted.target_type, confidence: extracted.confidence } })
    return data
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Quick capture failed"
    await serviceClient.from("quick_capture_drafts").update({ status: "failed", failure_reason: message }).eq("org_id", orgId).eq("id", draftId)
    throw cause
  }
}

export async function listQuickCaptureReviewTray(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "quick_capture.create", userId: context.userId, orgId: context.orgId, projectId, supabase: context.supabase, resourceType: "project", resourceId: projectId })
  const { data, error } = await context.supabase.from("quick_capture_drafts").select(DRAFT_SELECT).eq("org_id", context.orgId).eq("project_id", projectId).eq("created_by", context.userId).in("status", ["queued","processing","ready","failed"]).order("created_at", { ascending: false }).limit(100)
  if (error) throw new Error(`Failed to load quick-capture review tray: ${error.message}`)
  return data ?? []
}

export async function commitQuickCaptureDraft(draftId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { data: draft } = await context.supabase.from("quick_capture_drafts").select(DRAFT_SELECT).eq("org_id", context.orgId).eq("id", draftId).eq("created_by", context.userId).maybeSingle()
  if (!draft || draft.status !== "ready") throw new Error("Quick-capture draft is not ready.")
  const payload = quickCaptureExtractedPayloadSchema.parse(draft.extracted_payload)
  let entity: { id: string }
  if (payload.target_type === "task") {
    entity = await createTask({ input: { project_id: draft.project_id, title: payload.title, description: payload.description, status: "todo", priority: payload.priority, due_date: payload.due_date ?? undefined, location: payload.location ?? undefined } })
  } else if (payload.target_type === "rfi_draft") {
    entity = await createRfi({ input: { project_id: draft.project_id, subject: payload.title, question: payload.description, status: "draft", priority: payload.priority, due_date: payload.due_date }, sendNow: false })
  } else if (payload.target_type === "observation") {
    entity = await createObservation({ project_id: draft.project_id, kind: payload.observation_kind ?? "quality", category: payload.observation_category ?? "at_risk", description: `${payload.title}\n\n${payload.description}`, location: payload.location, due_date: payload.due_date, photo_file_id: draft.attachment_file_ids?.[0] ?? draft.source_file_id ?? null })
  } else if (payload.target_type === "punch_item") {
    await requireAuthorization({ permission: "punch.write", userId: context.userId, orgId: context.orgId, projectId: draft.project_id, supabase: context.supabase, logDecision: true, resourceType: "project", resourceId: draft.project_id })
    const { data, error } = await context.supabase.from("punch_items").insert({ org_id: context.orgId, project_id: draft.project_id, title: payload.title, description: payload.description, location: payload.location, due_date: payload.due_date, severity: payload.priority === "urgent" ? "critical" : payload.priority === "high" ? "major" : "minor", status: "open", created_by: context.userId }).select("id").single()
    if (error || !data) throw new Error(`Failed to create punch item: ${error?.message}`)
    entity = data
  } else {
    await requireAuthorization({ permission: "daily_log.write", userId: context.userId, orgId: context.orgId, projectId: draft.project_id, supabase: context.supabase, logDecision: true, resourceType: "project", resourceId: draft.project_id })
    const today = new Date().toISOString().slice(0, 10)
    let { data: log } = await context.supabase.from("daily_logs").select("id").eq("org_id", context.orgId).eq("project_id", draft.project_id).eq("log_date", today).maybeSingle()
    if (!log) {
      const created = await context.supabase.from("daily_logs").insert({ org_id: context.orgId, project_id: draft.project_id, log_date: today, summary: "Quick capture", created_by: context.userId }).select("id").single()
      if (created.error || !created.data) throw new Error(`Failed to create daily log: ${created.error?.message}`)
      log = created.data
    }
    const { data, error } = await context.supabase.from("daily_log_entries").insert({ org_id: context.orgId, project_id: draft.project_id, daily_log_id: log.id, entry_type: "note", description: `${payload.title}: ${payload.description}`, location: payload.location, metadata: { quick_capture_draft_id: draft.id } }).select("id").single()
    if (error || !data) throw new Error(`Failed to add daily-log note: ${error?.message}`)
    entity = data
  }
  const committedType = payload.target_type === "rfi_draft" ? "rfi" : payload.target_type === "daily_log_note" ? "daily_log_entry" : payload.target_type
  const { error: updateError } = await context.supabase.from("quick_capture_drafts").update({ status: "committed", committed_entity_type: committedType, committed_entity_id: entity.id }).eq("org_id", context.orgId).eq("id", draftId).eq("status", "ready")
  if (updateError) throw new Error(`Record was created but draft could not be closed: ${updateError.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "quick_capture_committed", entityType: "quick_capture_draft", entityId: draftId, payload: { project_id: draft.project_id, committed_entity_type: committedType, committed_entity_id: entity.id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "quick_capture_draft", entityId: draftId, before: draft, after: { status: "committed", committed_entity_type: committedType, committed_entity_id: entity.id } }),
  ])
  return { entity_type: committedType, entity_id: entity.id }
}
