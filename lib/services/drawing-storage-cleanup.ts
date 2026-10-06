import {
  abortDrawingPdfMultipartUpload,
  deleteDrawingPdfObject,
} from "@/lib/storage/drawings-pdfs-storage";
import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOrgContext } from "@/lib/services/context";
import { requireProjectPermission } from "@/lib/services/permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  deleteTilesObjects,
  listTilesObjectsPage,
} from "@/lib/storage/drawings-tiles-storage";
import { startDrawingLifecycleStage } from "@/lib/drawings/lifecycle-metrics";
const deletionSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  user_id: z.string().uuid(),
  kind: z.enum(["set", "sheets", "discard", "revision"]),
  target_ids: z.array(z.string().uuid()),
  deleted_sheet_ids: z.array(z.string().uuid()),
  artifact_ids: z.array(z.string().uuid()),
  retained_legacy_paths: z.array(z.string()).default([]),
  status: z.string(),
});
export type DrawingDeletionReceipt = z.infer<typeof deletionSchema>;
export type DrawingDeletionKind = DrawingDeletionReceipt["kind"];
export function drawingDeletionId(
  orgId: string,
  kind: DrawingDeletionKind,
  targets: string[],
) {
  const value = createHash("sha256")
    .update(JSON.stringify([orgId, kind, [...targets].sort()]))
    .digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
async function deleteDrawingsTransaction(
  input: {
    operationId?: string;
    projectId?: string;
    kind: DrawingDeletionKind;
    targetIds: string[];
  },
  orgId?: string,
): Promise<DrawingDeletionReceipt> {
  const targets = z
    .array(z.string().uuid())
    .min(1)
    .max(1000)
    .parse(input.targetIds);
  const auth = await requireOrgContext(orgId),
    supabase = createServiceSupabaseClient();
  const operationId = z
    .string()
    .uuid()
    .parse(
      input.operationId ?? drawingDeletionId(auth.orgId, input.kind, targets),
    );
  const prior = await supabase
    .from("drawing_deletion_operations")
    .select("*")
    .eq("id", operationId)
    .eq("org_id", auth.orgId)
    .maybeSingle();
  if (prior.error)
    throw new Error(`Unable to reconcile deletion: ${prior.error.message}`);
  if (prior.data) {
    const receipt = deletionSchema.parse(prior.data);
    await requireProjectPermission(
      auth.userId,
      receipt.project_id,
      "drawing.upload",
    );
    if (
      receipt.user_id !== auth.userId ||
      (input.projectId && receipt.project_id !== input.projectId) ||
      receipt.kind !== input.kind ||
      JSON.stringify([...receipt.target_ids].sort()) !==
        JSON.stringify([...new Set(targets)].sort())
    )
      throw new Error("Deletion operation conflicts with its original request");
    return receipt;
  }
  const table =
    input.kind === "set"
      ? "drawing_sets"
      : input.kind === "sheets"
        ? "drawing_sheets"
        : "drawing_revisions";
  const target = await supabase
    .from(table)
    .select("id,project_id")
    .eq("org_id", auth.orgId)
    .in("id", targets);
  if (
    target.error ||
    !target.data ||
    target.data.length !== new Set(targets).size
  )
    throw new Error("Drawing deletion target not found");
  const projectId = z.string().uuid().parse(target.data[0].project_id);
  if (
    target.data.some((row) => row.project_id !== projectId) ||
    (input.projectId && input.projectId !== projectId)
  )
    throw new Error("Deletion targets must belong to one project");
  await requireProjectPermission(auth.userId, projectId, "drawing.upload");
  const { data, error } = await supabase.rpc("delete_drawings_transaction", {
    p_id: operationId,
    p_org_id: auth.orgId,
    p_project_id: projectId,
    p_user_id: auth.userId,
    p_kind: input.kind,
    p_target_ids: targets,
  });
  if (error) throw new Error(error.message);
  return deletionSchema.parse(data);
}
/** Repeat first-page deletion: safe after partial batches and tokens invalidated by deletion. */
export async function deleteDrawingArtifactPrefix(
  supabase: SupabaseClient,
  orgId: string,
  prefix: string,
  budget = 10000,
) {
  if (
    !prefix.startsWith(`${orgId}/artifacts/`) &&
    !prefix.startsWith(`${orgId}/split/`)
  )
    throw new Error("Unowned drawing cleanup prefix");
  let deleted = 0;
  while (deleted < budget) {
    const page = await listTilesObjectsPage({ prefix: `${prefix}/` });
    if (page.objects.length === 0) return { complete: true, deleted };
    await deleteTilesObjects({
      supabase,
      paths: page.objects.map((row) => row.name),
    });
    deleted += page.objects.length;
  }
  return { complete: false, deleted };
}
export async function runDrawingStorageCleanup(
  supabase: SupabaseClient,
  orgId: string,
  deletionOperationId?: string,
) {
  z.string().uuid().parse(orgId);
  const finish = startDrawingLifecycleStage("cleanup", {
    operationId: deletionOperationId,
  });
  let storageDeletions = 0;
  try {
    const { data: candidates, error } = await supabase.rpc(
      "drawing_storage_cleanup_candidates",
      { p_org_id: orgId, p_limit: 50 },
    );
    if (error) throw new Error(error.message);
    let failures = 0;
    const deadline = Date.now() + 60_000;
    for (const candidate of z
      .array(
        z.object({
          id: z.string().uuid(),
          kind: z.enum(["artifact", "split"]),
        }),
      )
      .parse(candidates ?? [])) {
      if (Date.now() >= deadline || storageDeletions >= 5000) break;
      try {
        const split = candidate.kind === "split";
        const retired = await supabase.rpc(
          split ? "retire_drawing_split_page" : "retire_drawing_artifact",
          {
            p_org_id: orgId,
            ...(split
              ? { p_intent_id: candidate.id }
              : { p_artifact_id: candidate.id }),
          },
        );
        if (retired.error) throw new Error(retired.error.message);
        const result = z
          .object({
            retired: z.boolean(),
            storage_prefix: z.string().optional(),
            generation: z.string().optional(),
          })
          .parse(retired.data);
        if (!result.retired || !result.storage_prefix || !result.generation)
          continue;
        const deleted = await deleteDrawingArtifactPrefix(
          supabase,
          orgId,
          result.storage_prefix,
          Math.min(1000, 5000 - storageDeletions),
        );
        storageDeletions += deleted.deleted;
        if (deleted.complete) {
          const done = await supabase.rpc(
            split
              ? "complete_drawing_split_deletion"
              : "complete_drawing_artifact_deletion",
            {
              p_org_id: orgId,
              ...(split
                ? { p_intent_id: candidate.id }
                : { p_artifact_id: candidate.id }),
              p_generation: result.generation,
            },
          );
          if (done.error) throw new Error(done.error.message);
          const cleared = await supabase
            .from("drawing_cleanup_failures")
            .delete()
            .eq("org_id", orgId)
            .eq("kind", candidate.kind)
            .eq("entity_id", candidate.id);
          if (cleared.error) throw new Error(cleared.error.message);
        }
      } catch {
        failures++;
        const failed = await supabase.rpc("record_drawing_cleanup_failure", {
          p_org_id: orgId,
          p_kind: candidate.kind,
          p_entity_id: candidate.id,
        });
        if (failed.error) throw new Error("Unable to persist cleanup retry");
      }
    }
    await cleanupAbandonedDrawingUploads(supabase, orgId);
    finish(failures ? "failure" : "success", { storageDeletions });
  } catch (error) {
    finish("failure", { storageDeletions });
    throw error;
  }
}
export async function queueDrawingStorageReconciliation() {
  const supabase = createServiceSupabaseClient();
  const { error } = await supabase.rpc("queue_drawing_storage_reconciliation");
  if (error)
    throw new Error(`Drawing cleanup reconciliation failed: ${error.message}`);
}

async function cleanupAbandonedDrawingUploads(
  supabase: SupabaseClient,
  orgId: string,
) {
  const { data, error } = await supabase
    .from("drawing_abandoned_uploads")
    .select("id,operation_id,storage_path,multipart_upload_id")
    .eq("org_id", orgId)
    .lte("not_before", new Date().toISOString())
    .order("not_before")
    .limit(25);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) {
    try {
      const [files, active] = await Promise.all([
        supabase
          .from("files")
          .select("id")
          .eq("org_id", orgId)
          .eq("storage_path", row.storage_path)
          .limit(1),
        supabase
          .from("drawing_upload_operations")
          .select("id")
          .eq("org_id", orgId)
          .eq("storage_path", row.storage_path)
          .in("status", ["reserved", "registered"])
          .limit(1),
      ]);
      if (files.error || active.error)
        throw new Error("Unable to verify abandoned upload ownership");
      if (files.data?.length || active.data?.length) {
        const retained = await supabase
          .from("drawing_abandoned_uploads")
          .update({
            not_before: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          })
          .eq("org_id", orgId)
          .eq("id", row.id);
        if (retained.error) throw new Error(retained.error.message);
        continue;
      }
      if (row.multipart_upload_id)
        await abortDrawingPdfMultipartUpload({
          orgId,
          path: row.storage_path,
          uploadId: row.multipart_upload_id,
        });
      await deleteDrawingPdfObject({ orgId, path: row.storage_path });
      const updated = await supabase
        .from("drawing_abandoned_uploads")
        .update({
          cleaned_at: new Date().toISOString(),
          not_before: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
        .eq("org_id", orgId)
        .eq("id", row.id);
      if (updated.error) throw new Error(updated.error.message);
    } catch {
      const failed = await supabase.rpc("record_drawing_cleanup_failure", {
        p_org_id: orgId,
        p_kind: "upload",
        p_entity_id: row.id,
      });
      if (failed.error)
        throw new Error("Unable to persist abandoned upload retry");
    }
  }
}

export async function deleteDrawings(
  ...args: Parameters<typeof deleteDrawingsTransaction>
): Promise<DrawingDeletionReceipt> {
  const finish = startDrawingLifecycleStage("deletion_acknowledgement", {
    operationId: args[0].operationId,
  });
  try {
    const result = await deleteDrawingsTransaction(...args);
    finish("success");
    return result;
  } catch (error) {
    finish("failure");
    throw error;
  }
}
