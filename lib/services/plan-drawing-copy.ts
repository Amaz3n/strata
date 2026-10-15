import "server-only"
import { z } from "zod"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { copyFilesObject, headFilesCopySource } from "@/lib/storage/files-storage"

const receiptSchema = z.object({ file_id: z.string().uuid(), drawing_set_id: z.string().uuid(), revision_id: z.string().uuid(), job_id: z.string().regex(/^[1-9][0-9]*$/) })
const attemptFields = {
  attempt_id: z.string().uuid(), plan_version_id: z.string().uuid(), source_file_id: z.string().uuid(), actor_id: z.string().uuid(),
  storage_path: z.string().min(1), size_bytes: z.number().int().safe().positive(), source_etag: z.string().min(1).max(512),
}
const attemptSchema = z.discriminatedUnion("status", [
  z.object({ ...attemptFields, status: z.literal("reserved") }),
  z.object({ ...attemptFields, status: z.literal("published"), etag: z.string().min(1).max(512), receipt: receiptSchema }),
])

export async function publishPlanDrawingCopy(input: {
  orgId: string; projectId: string; planVersionId: string; actorId: string;
  source: { id: string; storage_path: string; mime_type: string | null; size_bytes: number | null }
}) {
  const supabase = createServiceSupabaseClient()
  // A published attempt can replay its verified DB receipt without touching R2.
  const { data: project, error: projectError } = await supabase.from("projects").select("metadata")
    .eq("org_id", input.orgId).eq("id", input.projectId).single()
  if (projectError || !project) throw new Error(`Unable to recover drawing copy state: ${projectError?.message ?? "project not found"}`)
  const saved = z.object({ plan_instantiation: z.object({ drawing_copy_attempt: attemptSchema.optional() }).optional() })
    .parse(project.metadata ?? {}).plan_instantiation?.drawing_copy_attempt
  // A published copy replays from its stored evidence without touching storage. A reservation
  // that never published is checked against the source as it is NOW: if the PDF changed since,
  // reserving with the fresh evidence is what releases the stale reservation for cleanup.
  let evidence: { size_bytes: number; source_etag: string }
  if (saved?.status === "published") {
    evidence = { size_bytes: saved.size_bytes, source_etag: saved.source_etag }
  } else {
    const head = await headFilesCopySource({ orgId: input.orgId, path: input.source.storage_path })
    if (input.source.size_bytes !== null && head.size !== input.source.size_bytes) throw new Error("Plan PDF size differs from its file record")
    evidence = { size_bytes: head.size, source_etag: head.sourceEtag }
  }
  const { data: reserved, error: reservationError } = await supabase.rpc("reserve_plan_drawing_copy", {
    p_org_id: input.orgId, p_project_id: input.projectId, p_plan_version_id: input.planVersionId, p_actor_id: input.actorId, p_source_evidence: evidence,
  })
  if (reservationError) throw new Error(`Unable to reserve drawing copy: ${reservationError.message}`)
  // The source changed under a reservation this release held: it was released for cleanup; the retry reserves the new version.
  if (z.object({ status: z.literal("abandoned") }).safeParse(reserved).success)
    throw new Error("The plan PDF changed after its copy was reserved; the stale reservation was released for cleanup and the release will retry")
  const attempt = attemptSchema.parse(reserved)
  if (attempt.plan_version_id !== input.planVersionId || attempt.source_file_id !== input.source.id || attempt.actor_id !== input.actorId)
    throw new Error("Reserved drawing copy does not match this release")
  const copied = attempt.status === "published" ? { etag: attempt.etag, size: attempt.size_bytes, sourceEtag: attempt.source_etag }
    : await copyFilesObject({ orgId: input.orgId, sourcePath: input.source.storage_path, destinationPath: attempt.storage_path,
      expectedSize: attempt.size_bytes, expectedSourceEtag: attempt.source_etag, contentType: input.source.mime_type ?? "application/pdf" })
  if (copied.size !== attempt.size_bytes || copied.sourceEtag !== attempt.source_etag) throw new Error("Drawing copy result differs from its reservation")
  const { data: published, error: publicationError } = await supabase.rpc("publish_plan_drawing_copy", {
    p_org_id: input.orgId, p_project_id: input.projectId, p_plan_version_id: input.planVersionId, p_actor_id: input.actorId,
    p_copy: { attempt_id: attempt.attempt_id, storage_path: attempt.storage_path, size_bytes: copied.size, source_etag: copied.sourceEtag, etag: copied.etag },
  })
  if (publicationError) throw new Error(`Unable to publish drawing copy: ${publicationError.message}`)
  const receipt = receiptSchema.parse(published)
  if (attempt.status === "published" && (receipt.file_id !== attempt.receipt.file_id || receipt.drawing_set_id !== attempt.receipt.drawing_set_id
    || receipt.revision_id !== attempt.receipt.revision_id || receipt.job_id !== attempt.receipt.job_id)) throw new Error("Drawing publication receipt changed during recovery")
  return { drawing_set_id: receipt.drawing_set_id, queued: true }
}
