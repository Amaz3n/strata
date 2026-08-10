import { z } from "zod"

import { runAiObject } from "@/lib/services/ai/gateway"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

const captionSchema = z.object({
  caption: z.string().trim().min(3).max(1000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30),
})

export async function processPhotoCaption(photoId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  if (!(await isAiSearchEnabledForOrg({ supabase, orgId }))) throw new Error("AI features are disabled for this organization")
  const { data: photo, error } = await supabase.from("photos").select("id,org_id,project_id,file_id,ai_processed_at,file:files!photos_file_id_fkey(storage_path,mime_type,file_name)").eq("org_id", orgId).eq("id", photoId).maybeSingle()
  if (error || !photo) throw new Error("Photo not found")
  if (photo.ai_processed_at) return photo
  const file = Array.isArray(photo.file) ? photo.file[0] : photo.file
  if (!file?.storage_path) throw new Error("Photo file is unavailable")
  const bytes = await downloadFilesObject({ supabase, orgId, path: file.storage_path })
  const result = await runAiObject({
    feature: "document_extraction",
    schema: captionSchema,
    system:
      "You caption construction progress photos factually. Describe only what is visible; never infer " +
      "unsafe conditions or facts the image does not show.",
    prompt:
      "Caption this construction progress photo. Tags should cover visible trade, phase, materials, and elements.",
    files: [{ data: bytes, mediaType: file.mime_type ?? "image/jpeg", filename: file.file_name ?? "photo.jpg" }],
    orgId,
    entityType: "photo",
    entityId: photoId,
    timeoutMs: 90_000,
    // Captions are a nicety on a background job; a stronger model is not worth it.
    allowEscalation: false,
  })
  if (!result.ok) throw new Error(`Photo captioning failed: ${result.message}`)
  const caption = result.object
  const normalizedTags = Array.from(new Set(caption.tags.map((tag) => tag.toLowerCase())))
  const { data, error: updateError } = await supabase.from("photos").update({ ai_caption: caption.caption, ai_tags: normalizedTags, ai_processed_at: new Date().toISOString() }).eq("org_id", orgId).eq("id", photoId).select("*").single()
  if (updateError || !data) throw new Error(`Failed to save photo caption: ${updateError?.message}`)
  await Promise.all([
    recordEvent({ orgId, eventType: "photo_captioned", entityType: "photo", entityId: photoId, payload: { project_id: photo.project_id, file_id: photo.file_id, tags: normalizedTags } }),
    recordAudit({ orgId, action: "update", entityType: "photo", entityId: photoId, after: { ai_caption: caption.caption, ai_tags: normalizedTags, ai_processed_at: data.ai_processed_at }, source: "photo_intelligence" }),
  ])
  return data
}
