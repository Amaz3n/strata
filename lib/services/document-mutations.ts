import "server-only"

import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission, requireProjectPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { MAX_BULK_FILE_OPERATION, normalizeFolderPath } from "@/lib/services/files"

const mutationInputSchema = z.object({
  fileIds: z.array(z.string().uuid()).max(MAX_BULK_FILE_OPERATION),
  kind: z.enum(["move", "archive", "restore"]),
  folderPath: z.string().max(4096).nullable().optional(),
  applyFolderDefaults: z.boolean().optional(),
})
const mutationResultSchema = z.object({
  receiptId: z.string().uuid().nullable(),
  projectIds: z.array(z.string().uuid()),
  files: z.array(z.object({
    id: z.string().uuid(),
    project_id: z.string().uuid().nullable(),
    folder_path: z.string().nullable(),
    share_with_clients: z.boolean(),
    share_with_subs: z.boolean(),
    archived_at: z.string().nullable(),
    updated_at: z.string(),
  })),
})
const scopeSchema = z.array(z.object({ id: z.string().uuid(), project_id: z.string().uuid().nullable() }))
const receiptSchema = z.object({ kind: mutationInputSchema.shape.kind, project_ids: z.array(z.string().uuid()) })
export type DocumentMutationResult = z.infer<typeof mutationResultSchema>

function mutationError(error: { code?: string; message: string }): Error {
  if (error.code === "PGRST202" || error.code === "42883" || error.code === "42P01") {
    return new Error("Document mutations require the pending document mutation database migration.")
  }
  return new Error(error.message)
}

/** The service supplies authorized project scopes; the RPC verifies them again under row locks. */
export async function mutateDocuments(input: z.input<typeof mutationInputSchema>): Promise<DocumentMutationResult> {
  const parsed = mutationInputSchema.parse(input)
  const fileIds = [...new Set(parsed.fileIds)]
  const context = await requireOrgContext()
  const permission = parsed.kind === "move" ? "docs.upload" : "docs.delete"
  await requirePermission(permission, context)
  if (!fileIds.length) return { receiptId: null, projectIds: [], files: [] }
  const { data, error } = await context.supabase.from("files")
    .select("id, project_id").eq("org_id", context.orgId).in("id", fileIds)
  if (error) throw new Error(`Could not load selected documents: ${error.message}`)
  const rows = scopeSchema.parse(data ?? [])
  if (rows.length !== fileIds.length) throw new Error("One or more selected files are unavailable")
  const projectIds = [...new Set(rows.flatMap((file) => file.project_id ? [file.project_id] : []))]
  await Promise.all(projectIds.map((projectId) => requireProjectPermission(context.userId, projectId, permission)))
  const folderPath = normalizeFolderPath(parsed.folderPath)
  const { data: result, error: mutationFailure } = await createServiceSupabaseClient().rpc("mutate_documents", {
    p_org_id: context.orgId,
    p_actor_id: context.userId,
    p_file_ids: fileIds,
    p_scopes: Object.fromEntries(rows.map((file) => [file.id, file.project_id])),
    p_kind: parsed.kind,
    p_folder_path: folderPath === "/" ? null : folderPath ?? null,
    p_apply_folder_defaults: parsed.applyFolderDefaults ?? true,
  })
  if (mutationFailure) throw mutationError(mutationFailure)
  return mutationResultSchema.parse(result)
}

/** Undo trusts only a server-owned receipt and rechecks current project permissions. */
export async function undoDocumentMutation(receiptId: string): Promise<DocumentMutationResult> {
  z.string().uuid().parse(receiptId)
  const context = await requireOrgContext()
  const service = createServiceSupabaseClient()
  const { data, error } = await service.from("document_mutation_receipts")
    .select("kind, project_ids").eq("org_id", context.orgId).eq("actor_id", context.userId).eq("id", receiptId).maybeSingle()
  if (error) throw mutationError(error)
  if (!data) throw new Error("Undo receipt is unavailable")
  const receipt = receiptSchema.parse(data)
  const permission = receipt.kind === "move" ? "docs.upload" : "docs.delete"
  await requirePermission(permission, context)
  await Promise.all(receipt.project_ids.map((projectId) => requireProjectPermission(context.userId, projectId, permission)))
  const { data: result, error: undoFailure } = await service.rpc("undo_document_mutation", {
    p_org_id: context.orgId,
    p_actor_id: context.userId,
    p_receipt_id: receiptId,
  })
  if (undoFailure) throw mutationError(undoFailure)
  return mutationResultSchema.parse(result)
}
