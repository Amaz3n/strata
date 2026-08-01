import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { enqueueOutboxJob } from "@/lib/services/outbox"

/**
 * Re-enqueue preview generation for images that predate the responsive ladder.
 *
 * Files whose `metadata.preview` has no `thumbhash` were previewed by the old
 * single-thumbnail job. Re-running `generate_file_preview` over them fills in
 * dimensions, the thumbhash placeholder and the WebP/AVIF ladder. The outbox
 * job dedupes on fileId, so a batch that overlaps an in-flight one is a no-op.
 */
const DEFAULT_BATCH_SIZE = 200

export async function backfillImagePreviews({
  batchSize = DEFAULT_BATCH_SIZE,
}: { batchSize?: number } = {}): Promise<{ scanned: number; enqueued: number }> {
  const supabase = createServiceSupabaseClient()

  // Rate-limited by construction: one bounded batch per invocation, and the
  // rows drop out of this filter as their previews regenerate.
  const { data, error } = await supabase
    .from("files")
    .select("id, org_id")
    .like("mime_type", "image/%")
    .is("metadata->preview->thumbhash", null)
    .limit(batchSize)

  if (error) {
    throw new Error(`Unable to scan files for preview backfill: ${error.message}`)
  }

  const rows = data ?? []
  let enqueued = 0
  for (const row of rows) {
    if (!row.org_id) continue
    await enqueueOutboxJob({
      orgId: row.org_id,
      jobType: "generate_file_preview",
      payload: { fileId: row.id },
      runAt: new Date().toISOString(),
      dedupeByPayloadKeys: ["fileId"],
    })
    enqueued += 1
  }

  return { scanned: rows.length, enqueued }
}
