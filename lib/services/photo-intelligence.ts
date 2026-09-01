import { z } from "zod"

import { exifTakenAtIso, readPhotoExif } from "@/lib/media/exif"
import { isBusinessDocumentCategory } from "@/lib/media/photo-media"
import { runAiObject } from "@/lib/services/ai/gateway"
import { isAiSearchEnabledForOrg } from "@/lib/services/ai-search-flags"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { downloadFilesObject } from "@/lib/storage/files-storage"

const captionSchema = z.object({
  caption: z.string().trim().min(3).max(1000),
  tags: z.array(z.string().trim().min(1).max(80)).max(30),
})

/**
 * Fill in a photo's capture time and location from the file itself, and get it
 * into the caption queue.
 *
 * This runs from `generate_file_preview`, which fires for every image whatever
 * uploaded it — the photos workbench, a daily log, a punch item, the mobile app.
 * That breadth is the point: enqueuing captions only from the upload surfaces
 * would leave the same gap that left `ai_caption` null for every photo in Arc
 * while the workbench offered to search captions.
 *
 * Capture time is only written when the file settles the timezone question on
 * its own (an offset tag, or a GPS clock to difference against). When it does
 * not, the upload time stays — a wrong instant is worse than an approximate one,
 * and `lib/media/exif.ts` lays out why the server cannot guess.
 */
export async function enrichPhotoFromSource(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  fileId: string
  bytes: Buffer
  /** The file's category, so paperwork does not get captioned. */
  category?: string | null
}): Promise<void> {
  const { supabase, orgId, fileId, bytes, category } = params

  const { data: photo } = await supabase
    .from("photos")
    .select("id, project_id, taken_at, created_at, latitude, longitude, ai_processed_at")
    .eq("org_id", orgId)
    .eq("file_id", fileId)
    .maybeSingle()
  if (!photo) return

  const exif = readPhotoExif(bytes)
  const patch: Record<string, unknown> = {}

  // `taken_at` defaults to the file's creation time. Anything else means a client
  // that knew better already set it, and this must not overwrite that.
  const untouched = photo.taken_at === photo.created_at
  if (untouched) {
    const takenAt = exifTakenAtIso(exif)
    if (takenAt) patch.taken_at = takenAt
  }
  if (photo.latitude === null && exif.latitude !== null) patch.latitude = exif.latitude
  if (photo.longitude === null && exif.longitude !== null) patch.longitude = exif.longitude

  if (Object.keys(patch).length > 0) {
    await supabase.from("photos").update(patch).eq("org_id", orgId).eq("id", photo.id)
  }

  // Capture time and GPS are recorded for every image — cheap, and correct if the
  // file is ever recategorised. Captioning is not: a receipt costs a model call
  // to describe something the photos workbench does not show and nobody searches
  // for as a photo.
  if (isBusinessDocumentCategory(category)) return

  if (!photo.ai_processed_at && (await isAiSearchEnabledForOrg({ supabase, orgId }))) {
    await enqueueOutboxJob({
      orgId,
      jobType: "caption_photo",
      payload: { photo_id: photo.id, project_id: photo.project_id },
      dedupeByPayloadKeys: ["photo_id"],
    })
  }
}

export async function processPhotoCaption(photoId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  // Nothing to do rather than nothing we can do. Captioning is now queued for
  // every image that gets a preview, so an org with AI switched off would
  // otherwise mint a permanently failing job per photo.
  if (!(await isAiSearchEnabledForOrg({ supabase, orgId }))) return null
  const { data: photo, error } = await supabase.from("photos").select("id,org_id,project_id,file_id,ai_processed_at,file:files!photos_file_id_fkey(storage_path,mime_type,file_name)").eq("org_id", orgId).eq("id", photoId).maybeSingle()
  if (error || !photo) throw new Error("Photo not found")
  if (photo.ai_processed_at) return photo
  const file = Array.isArray(photo.file) ? photo.file[0] : photo.file
  if (!file?.storage_path) throw new Error("Photo file is unavailable")
  // Video records live in the same table and the model reads still images only.
  if (file.mime_type?.startsWith("video/")) return photo
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
