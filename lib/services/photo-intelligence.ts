import { generateText } from "ai"
import { z } from "zod"

import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getApiKeyForProvider, resolveLanguageModel } from "@/lib/services/ai-search/llm"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

const captionSchema = z.object({
  caption: z.string().trim().min(3).max(1000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30),
})

function jsonCandidate(raw: string) {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim()
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
}

export async function processPhotoCaption(photoId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  if (!(await isAiSearchEnabledForOrg({ supabase, orgId }))) throw new Error("AI features are disabled for this organization")
  const { data: photo, error } = await supabase.from("photos").select("id,org_id,project_id,file_id,ai_processed_at,file:files!photos_file_id_fkey(storage_path,mime_type,file_name)").eq("org_id", orgId).eq("id", photoId).maybeSingle()
  if (error || !photo) throw new Error("Photo not found")
  if (photo.ai_processed_at) return photo
  const file = Array.isArray(photo.file) ? photo.file[0] : photo.file
  if (!file?.storage_path) throw new Error("Photo file is unavailable")
  const config = await getPlatformAiFeatureDefaultConfig({ supabase, feature: "document_extraction" })
  const key = getApiKeyForProvider(config.provider)
  if (!key) throw new Error(`${config.provider} is not configured for photo captioning`)
  const bytes = await downloadFilesObject({ supabase, orgId, path: file.storage_path })
  const result = await generateText({
    model: resolveLanguageModel(config.provider, key, config.model),
    messages: [{ role: "user", content: [
      { type: "text", text: "Caption this construction progress photo factually. Return JSON only: {caption:string,tags:string[]}. Tags should cover visible trade, phase, materials, and elements. Do not infer unsafe or invisible facts." },
      { type: "file", data: bytes, mediaType: file.mime_type ?? "image/jpeg", filename: file.file_name ?? "photo.jpg" },
    ] }],
    abortSignal: AbortSignal.timeout(90_000),
  })
  const caption = captionSchema.parse(JSON.parse(jsonCandidate(result.text)))
  const normalizedTags = Array.from(new Set(caption.tags.map((tag) => tag.toLowerCase())))
  const { data, error: updateError } = await supabase.from("photos").update({ ai_caption: caption.caption, ai_tags: normalizedTags, ai_processed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", photoId).select("*").single()
  if (updateError || !data) throw new Error(`Failed to save photo caption: ${updateError?.message}`)
  await Promise.all([
    recordEvent({ orgId, eventType: "photo_captioned", entityType: "photo", entityId: photoId, payload: { project_id: photo.project_id, file_id: photo.file_id, tags: normalizedTags } }),
    recordAudit({ orgId, action: "update", entityType: "photo", entityId: photoId, after: { ai_caption: caption.caption, ai_tags: normalizedTags, ai_processed_at: data.ai_processed_at }, source: "photo_intelligence" }),
  ])
  return data
}
