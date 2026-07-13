import "server-only"

import { generateText } from "ai"
import { z } from "zod"
import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { addMeetingItem, getMeeting, updateMeetingItem } from "@/lib/services/meetings"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { deleteFilesObjects, downloadFilesObject } from "@/lib/storage/files-storage"

const existingProposalSchema = z.object({
  item_id: z.string().uuid(),
  discussion_update: z.string().max(10000).nullable().default(null),
  proposed_status: z.enum(["open", "closed", "info"]).nullable().default(null),
  proposed_bic: z.string().max(160).nullable().default(null),
  proposed_due: z.string().date().nullable().default(null),
  review_status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
})
const newProposalSchema = z.object({
  topic: z.string().min(2).max(500),
  discussion: z.string().max(10000).nullable().default(null),
  status: z.enum(["open", "closed", "info"]).default("open"),
  ball_in_court: z.string().max(160).nullable().default(null),
  due_date: z.string().date().nullable().default(null),
  review_status: z.enum(["pending", "accepted", "rejected"]).default("pending"),
})
const proposalsSchema = z.object({ existing_items: z.array(existingProposalSchema).max(250), new_items: z.array(newProposalSchema).max(100) })
export type MeetingDraftProposals = z.infer<typeof proposalsSchema>

export type MeetingTranscript = {
  id: string; meeting_id: string; project_id: string; source: "recorded" | "audio_upload" | "pasted"
  status: "pending" | "transcribing" | "ready" | "failed"; transcript_text: string | null
  audio_file_id: string | null; error: string | null; draft_proposals: MeetingDraftProposals | null
  created_at: string; updated_at: string
}

function stripVtt(value: string) {
  return value.replace(/^WEBVTT.*$/gim, "").replace(/^\d+\s*$/gm, "").replace(/^\d{2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->.*$/gm, "").replace(/<[^>]+>/g, "").replace(/\n{3,}/g, "\n\n").trim()
}

async function editableContext(meetingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("meeting.write", { supabase: context.supabase, orgId: context.orgId, userId: context.userId })
  const { data: meeting } = await context.supabase.from("meetings").select("id, project_id, status").eq("org_id", context.orgId).eq("id", meetingId).maybeSingle()
  if (!meeting) throw new Error("Meeting not found")
  if (meeting.status === "finalized") throw new Error("Finalized meeting minutes are locked")
  return { ...context, meeting }
}

export async function listMeetingTranscripts(meetingId: string, orgId?: string): Promise<MeetingTranscript[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.read", { supabase, orgId: resolvedOrgId, userId })
  const { data, error } = await supabase.from("meeting_transcripts").select("*").eq("org_id", resolvedOrgId).eq("meeting_id", meetingId).order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to load meeting transcripts: ${error.message}`)
  return (data ?? []) as MeetingTranscript[]
}

export async function createPastedMeetingTranscript(input: { meetingId: string; text: string }, orgId?: string) {
  const text = stripVtt(input.text)
  if (text.length < 10 || text.length > 1_000_000) throw new Error("Paste a transcript between 10 and 1,000,000 characters")
  const context = await editableContext(input.meetingId, orgId)
  const { data, error } = await context.supabase.from("meeting_transcripts").insert({ org_id: context.orgId, project_id: context.meeting.project_id, meeting_id: input.meetingId, source: "pasted", status: "ready", transcript_text: text, transcribed_at: new Date().toISOString(), created_by: context.userId }).select("*").single()
  if (error || !data) throw new Error(`Failed to save transcript: ${error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "meeting_transcript", entityId: data.id, after: { source: "pasted", characters: text.length } })
  return data as MeetingTranscript
}

export async function createAudioMeetingTranscript(input: { meetingId: string; fileId: string; source: "recorded" | "audio_upload" }, orgId?: string) {
  const context = await editableContext(input.meetingId, orgId)
  const { data: file } = await context.supabase.from("files").select("id").eq("org_id", context.orgId).eq("project_id", context.meeting.project_id).eq("id", input.fileId).maybeSingle()
  if (!file) throw new Error("Audio file does not belong to this project")
  const { data, error } = await context.supabase.from("meeting_transcripts").insert({ org_id: context.orgId, project_id: context.meeting.project_id, meeting_id: input.meetingId, source: input.source, status: "pending", audio_file_id: input.fileId, created_by: context.userId }).select("*").single()
  if (error || !data) throw new Error(`Failed to queue transcription: ${error?.message}`)
  return data as MeetingTranscript
}

async function transcribeOpenAi(bytes: Buffer, mimeType: string, fileName: string, model: string) {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key) throw new Error("OPENAI_API_KEY is not configured for transcription")
  const form = new FormData(); form.set("model", model); form.set("file", new File([new Uint8Array(bytes)], fileName, { type: mimeType || "audio/webm" }))
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(15 * 60_000) })
  if (!response.ok) throw new Error(`Transcription provider returned ${response.status}: ${(await response.text()).slice(0, 500)}`)
  const body = await response.json() as { text?: string }
  if (!body.text?.trim()) throw new Error("Transcription provider returned no text")
  return body.text.trim()
}

export async function processPendingMeetingTranscripts(limit = 3) {
  const supabase = createServiceSupabaseClient()
  const { data: rows, error } = await supabase.from("meeting_transcripts").select("id, org_id, audio_file_id, files!meeting_transcripts_audio_file_id_fkey(storage_path, mime_type, file_name)").eq("status", "pending").order("created_at").limit(limit)
  if (error) throw new Error(`Failed to load pending transcripts: ${error.message}`)
  let completed = 0; let failed = 0
  for (const row of rows ?? []) {
    await supabase.from("meeting_transcripts").update({ status: "transcribing", error: null }).eq("id", row.id).eq("status", "pending")
    try {
      const file = Array.isArray(row.files) ? row.files[0] : row.files
      if (!file?.storage_path) throw new Error("Audio file is unavailable")
      const config = await getPlatformAiFeatureDefaultConfig({ supabase, feature: "transcription" })
      const bytes = await downloadFilesObject({ supabase, orgId: row.org_id, path: file.storage_path })
      let text: string
      if (config.provider === "openai") {
        text = await transcribeOpenAi(bytes, file.mime_type ?? "audio/webm", file.file_name ?? "meeting.webm", config.model)
      } else if (config.provider === "google") {
        const key = getApiKeyForProvider("google"); if (!key) throw new Error("Google AI is not configured for transcription")
        const result = await generateText({ model: resolveLanguageModel("google", key, config.model), messages: [{ role: "user", content: [{ type: "text", text: "Transcribe this construction meeting audio verbatim. Preserve speaker labels when discernible. Return transcript text only." }, { type: "file", data: bytes, mediaType: file.mime_type ?? "audio/webm", filename: file.file_name ?? "meeting.webm" }] }], abortSignal: AbortSignal.timeout(15 * 60_000) })
        text = result.text.trim(); if (!text) throw new Error("Google transcription returned no text")
      } else {
        throw new Error("Anthropic does not expose an audio transcription endpoint; choose OpenAI or Google")
      }
      await supabase.from("meeting_transcripts").update({ status: "ready", transcript_text: text, transcribed_at: new Date().toISOString() }).eq("id", row.id)
      completed += 1
    } catch (cause) {
      await supabase.from("meeting_transcripts").update({ status: "failed", error: cause instanceof Error ? cause.message : "Transcription failed" }).eq("id", row.id)
      failed += 1
    }
  }
  return { processed: (rows ?? []).length, completed, failed }
}

function jsonCandidate(raw: string) {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim(); const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}")
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
}

export async function draftMinutesFromTranscript(transcriptId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("meeting.write", { supabase: context.supabase, orgId: context.orgId, userId: context.userId })
  const { data: transcript } = await context.supabase.from("meeting_transcripts").select("*").eq("org_id", context.orgId).eq("id", transcriptId).eq("status", "ready").single()
  if (!transcript?.transcript_text) throw new Error("Transcript is not ready")
  const meeting = await getMeeting(transcript.meeting_id, context.orgId)
  if (meeting.status === "finalized") throw new Error("Finalized meeting minutes are locked")
  const config = await getPlatformAiFeatureDefaultConfig({ supabase: createServiceSupabaseClient(), feature: "meeting_minutes" })
  const key = getApiKeyForProvider(config.provider); if (!key) throw new Error(`${config.provider} is not configured`)
  const prompt = `Extract proposed meeting-minutes updates. Return JSON only: {"existing_items":[{"item_id":"uuid","discussion_update":string|null,"proposed_status":"open|closed|info"|null,"proposed_bic":string|null,"proposed_due":"YYYY-MM-DD"|null}],"new_items":[{"topic":string,"discussion":string|null,"status":"open|closed|info","ball_in_court":string|null,"due_date":"YYYY-MM-DD"|null}]}. Never invent facts.\n\nCURRENT REGISTER:\n${JSON.stringify(meeting.items.map((item) => ({ item_id: item.id, number: item.item_number, topic: item.topic, discussion: item.discussion, status: item.status, bic: item.ball_in_court, due: item.due_date, linked: item.linked_entity })))}\n\nTRANSCRIPT:\n${transcript.transcript_text}`
  let parsed: MeetingDraftProposals | null = null; let lastError = "Invalid structured response"
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await generateText({ model: resolveLanguageModel(config.provider, key, config.model), prompt: attempt ? `${prompt}\n\nYour previous response was invalid. Return ONLY schema-compliant JSON.` : prompt, abortSignal: AbortSignal.timeout(90_000) })
    try { parsed = proposalsSchema.parse(JSON.parse(jsonCandidate(result.text))); break } catch (error) { lastError = error instanceof Error ? error.message : lastError }
  }
  if (!parsed) throw new Error(`AI proposals failed validation after retry: ${lastError}`)
  const knownIds = new Set(meeting.items.map((item) => item.id)); parsed.existing_items = parsed.existing_items.filter((item) => knownIds.has(item.item_id))
  const { error } = await context.supabase.from("meeting_transcripts").update({ draft_proposals: parsed }).eq("org_id", context.orgId).eq("id", transcriptId)
  if (error) throw new Error(`Failed to store draft proposals: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "meeting_transcript", entityId: transcriptId, after: { proposals: parsed } })
  return parsed
}

export async function reviewMeetingDraftProposal(input: { transcriptId: string; kind: "existing" | "new"; index: number; decision: "accepted" | "rejected"; edited?: Record<string, unknown> }, orgId?: string) {
  const context = await requireOrgContext(orgId); await requirePermission("meeting.write", { supabase: context.supabase, orgId: context.orgId, userId: context.userId })
  const { data: transcript } = await context.supabase.from("meeting_transcripts").select("meeting_id, draft_proposals").eq("org_id", context.orgId).eq("id", input.transcriptId).single()
  if (!transcript) throw new Error("Transcript not found")
  const proposals = proposalsSchema.parse(transcript.draft_proposals); const list = input.kind === "existing" ? proposals.existing_items : proposals.new_items; const proposal = list[input.index]
  if (!proposal) throw new Error("Proposal not found"); if (proposal.review_status !== "pending") return proposals
  if (input.decision === "accepted") {
    if (input.kind === "existing") {
      const p = existingProposalSchema.parse({ ...proposal, ...(input.edited ?? {}) })
      await updateMeetingItem(p.item_id, { discussion: p.discussion_update, status: p.proposed_status ?? undefined, ball_in_court: p.proposed_bic, due_date: p.proposed_due }, context.orgId)
    } else {
      const p = newProposalSchema.parse({ ...proposal, ...(input.edited ?? {}) })
      await addMeetingItem({ meeting_id: transcript.meeting_id, topic: p.topic, discussion: p.discussion, status: p.status, ball_in_court: p.ball_in_court, due_date: p.due_date }, context.orgId)
    }
  }
  proposal.review_status = input.decision
  await context.supabase.from("meeting_transcripts").update({ draft_proposals: proposals }).eq("org_id", context.orgId).eq("id", input.transcriptId)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "meeting_transcript_proposal", entityId: input.transcriptId, after: { kind: input.kind, index: input.index, decision: input.decision } })
  return proposals
}

export async function cleanupMeetingTranscriptAudio({ dryRun = false }: { dryRun?: boolean } = {}) {
  const supabase = createServiceSupabaseClient(); const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data, error } = await supabase.from("meeting_transcripts").select("id, org_id, audio_file_id, files!meeting_transcripts_audio_file_id_fkey(storage_path)").eq("status", "ready").not("audio_file_id", "is", null).is("audio_deleted_at", null).lt("transcribed_at", cutoff).limit(100)
  if (error) throw new Error(`Failed to load transcript retention queue: ${error.message}`)
  if (dryRun) return { candidates: (data ?? []).length, deleted: 0 }
  let deleted = 0
  for (const row of data ?? []) { const file = Array.isArray(row.files) ? row.files[0] : row.files; if (file?.storage_path) await deleteFilesObjects({ supabase, orgId: row.org_id, paths: [file.storage_path] }); await supabase.from("meeting_transcripts").update({ audio_file_id: null, audio_deleted_at: new Date().toISOString() }).eq("id", row.id); if (row.audio_file_id) await supabase.from("files").delete().eq("org_id", row.org_id).eq("id", row.audio_file_id); deleted += 1 }
  return { candidates: (data ?? []).length, deleted }
}
