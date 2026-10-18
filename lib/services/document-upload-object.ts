import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { headFilesObject } from "@/lib/storage/files-storage"

/** The reservation owns intent; the object store proves transfer completion. */
export async function assertDocumentUploadObject(input: {
  orgId: string; userId: string; projectId?: string | null; storagePath: string;
  fileName: string; mimeType?: string; sizeBytes?: number; requireReservation?: boolean
}): Promise<void> {
  const [{ data: transfer, error }, object] = await Promise.all([
    createServiceSupabaseClient().from("document_upload_transfers")
      .select("id, created_by, project_id, file_name, content_type, file_size, identity, cancelled_at")
      .eq("org_id", input.orgId).eq("storage_path", input.storagePath).maybeSingle(),
    headFilesObject({ orgId: input.orgId, path: input.storagePath }),
  ])
  if (error) throw new Error(`Unable to verify upload reservation: ${error.message}`)
  if (!Number.isSafeInteger(input.sizeBytes) || !input.sizeBytes || object.size !== input.sizeBytes) {
    throw new Error("Uploaded object size does not match the file")
  }
  // Older upload clients and server-generated objects predate reservations.
  if (!transfer) {
    if (input.requireReservation) throw new Error("Upload reservation is required")
    return
  }
  if (transfer.cancelled_at || transfer.created_by !== input.userId ||
      transfer.project_id !== (input.projectId ?? null) || transfer.file_name !== input.fileName ||
      transfer.content_type !== (input.mimeType || "application/octet-stream") || transfer.file_size !== input.sizeBytes ||
      object.metadata?.["transfer-id"] !== transfer.id || object.metadata?.["content-identity"] !== transfer.identity) {
    throw new Error("Uploaded object does not match its reservation")
  }
}
