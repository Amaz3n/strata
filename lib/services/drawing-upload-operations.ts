import "server-only";
import { z } from "zod";
import { createHash } from "node:crypto";
import { requireOrgContext } from "@/lib/services/context";
import { requireProjectPermission } from "@/lib/services/permissions";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { headDrawingPdfObject } from "@/lib/storage/drawings-pdfs-storage";
import { getDrawingSet } from "@/lib/services/drawings";
import { triggerDrawingsPipeline } from "@/lib/services/drawings-pipeline-trigger";
import { startDrawingLifecycleStage } from "@/lib/drawings/lifecycle-metrics";

const baseIntentSchema = z.object({
  projectId: z.string().uuid(),
  sourceFileId: z.string().uuid().optional(),
  fileName: z.string().min(1).max(512),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 ** 3),
  mimeType: z.literal("application/pdf"),
  targetSheetId: z.string().uuid().optional(),
  title: z.string().max(250).optional(),
  setType: z.string().max(80).optional(),
  issuanceLabel: z.string().max(250).optional(),
  issuanceType: z
    .enum([
      "revision",
      "asi",
      "bulletin",
      "addendum",
      "ifc_set",
      "permit_set",
      "bid_set",
      "sketch",
      "record_set",
      "other",
    ])
    .optional(),
  issuedDate: z.string().max(40).optional(),
  issuedBy: z.string().max(250).optional(),
  receivedFrom: z.string().max(250).optional(),
  notes: z.string().max(10000).optional(),
  fingerprint: z
    .string()
    .regex(/^sha256-chain-v1:\d+:[a-f0-9]{64}$/)
    .optional(),
});
const intentSchema = baseIntentSchema.superRefine((intent, ctx) => {
  if (
    !intent.sourceFileId &&
    (!intent.fingerprint ||
      Number(intent.fingerprint.split(":")[1]) !== intent.fileSize)
  )
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "PDF fingerprint must match the reserved file size",
      path: ["fingerprint"],
    });
});
const operationSchema = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid(),
  project_id: z.string().uuid(),
  user_id: z.string().uuid(),
  generation: z.string().uuid(),
  intent: intentSchema,
  storage_path: z.string(),
  status: z.enum(["reserved", "registered", "cancelled", "expired"]),
  expires_at: z.string(),
  file_id: z.string().uuid().nullable(),
  revision_id: z.string().uuid().nullable(),
  drawing_set_id: z.string().uuid().nullable(),
  transfer_id: z.string().uuid().nullable(),
  multipart_upload_id: z.string().nullable(),
});
export type DrawingUploadOperation = z.infer<typeof operationSchema>;
export type DrawingUploadIntent = z.infer<typeof intentSchema>;
export type DrawingUploadInput = DrawingUploadIntent & {
  operationId?: string;
  storagePath: string;
  generation?: string;
};
const ids = z.object({
  operationId: z.string().uuid(),
  projectId: z.string().uuid(),
});
async function context(projectId: string) {
  const auth = await requireOrgContext();
  await requireProjectPermission(auth.userId, projectId, "drawing.upload");
  return { ...auth, supabase: createServiceSupabaseClient() };
}
export async function getDrawingUploadOperation(
  operationId: string,
  projectId: string,
) {
  ids.parse({ operationId, projectId });
  const { orgId, userId, supabase } = await context(projectId);
  const { data, error } = await supabase
    .from("drawing_upload_operations")
    .select("*")
    .eq("id", operationId)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error)
    throw new Error(`Unable to read upload operation: ${error.message}`);
  return data ? operationSchema.parse(data) : null;
}
export async function reserveDrawingUpload(
  input: DrawingUploadIntent & { operationId: string },
) {
  z.string().uuid().parse(input.operationId);
  const intent = intentSchema.parse(input);
  const { orgId, userId, supabase } = await context(intent.projectId);
  const { data, error } = await supabase.rpc("reserve_drawing_upload", {
    p_id: input.operationId,
    p_org_id: orgId,
    p_project_id: intent.projectId,
    p_user_id: userId,
    p_intent: intent,
  });
  if (error) throw new Error(error.message);
  return operationSchema.parse(data);
}
export async function getDrawingUploadOperationForTransfer(input: {
  operationId: string;
  projectId: string;
  orgId: string;
  userId: string;
}) {
  ids.parse(input);
  await requireProjectPermission(
    input.userId,
    input.projectId,
    "drawing.upload",
  );
  const { data, error } = await createServiceSupabaseClient()
    .from("drawing_upload_operations")
    .select("*")
    .eq("id", input.operationId)
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error || !data) throw new Error("Upload operation not found");
  const operation = operationSchema.parse(data);
  if (
    operation.status !== "reserved" ||
    Date.parse(operation.expires_at) <= Date.now()
  )
    throw new Error("Upload reservation expired or is no longer active");
  if (operation.intent.sourceFileId)
    throw new Error("Library source does not accept transfers");
  return operation;
}
export async function claimDrawingUploadTransfer(input: {
  operationId: string;
  projectId: string;
  orgId: string;
  userId: string;
  generation: string;
  transferId: string;
  uploadId?: string;
}) {
  ids.parse(input);
  z.string().uuid().parse(input.generation);
  z.string().uuid().parse(input.transferId);
  const { data, error } = await createServiceSupabaseClient().rpc(
    "claim_drawing_upload_transfer",
    {
      p_id: input.operationId,
      p_org_id: input.orgId,
      p_project_id: input.projectId,
      p_user_id: input.userId,
      p_generation: input.generation,
      p_transfer_id: input.transferId,
      p_upload_id: input.uploadId ?? null,
    },
  );
  if (error) throw new Error(error.message);
  return operationSchema.parse(data);
}
export async function cancelDrawingUpload(
  operationId: string,
  projectId: string,
) {
  ids.parse({ operationId, projectId });
  const { orgId, userId, supabase } = await context(projectId);
  const { data, error } = await supabase.rpc("cancel_drawing_upload", {
    p_id: operationId,
    p_org_id: orgId,
    p_project_id: projectId,
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
  return operationSchema.parse(data);
}
export async function renewDrawingUpload(
  operationId: string,
  projectId: string,
  generation: string,
) {
  ids.parse({ operationId, projectId });
  z.string().uuid().parse(generation);
  const { orgId, userId, supabase } = await context(projectId);
  const { data, error } = await supabase.rpc("renew_drawing_upload", {
    p_id: operationId,
    p_org_id: orgId,
    p_project_id: projectId,
    p_user_id: userId,
    p_generation: generation,
  });
  if (error) throw new Error(error.message);
  return operationSchema.parse(data);
}
export async function finalizeDrawingUpload(input: DrawingUploadInput) {
  const projectId = z.string().uuid().parse(input.projectId);
  const { orgId, userId, supabase } = await context(projectId);
  if (input.sourceFileId) {
    z.string().uuid().parse(input.sourceFileId);
    const source = await supabase
      .from("files")
      .select("file_name,size_bytes,mime_type,storage_path")
      .eq("id", input.sourceFileId)
      .eq("org_id", orgId)
      .eq("project_id", projectId)
      .is("archived_at", null)
      .maybeSingle();
    if (
      source.error ||
      !source.data ||
      source.data.mime_type !== "application/pdf"
    )
      throw new Error("Source PDF not found");
    input = {
      ...input,
      fileName: source.data.file_name,
      fileSize: source.data.size_bytes,
      mimeType: "application/pdf",
      storagePath: source.data.storage_path,
    };
  }
  const intent = baseIntentSchema.parse(input);
  // Library operations use a stable key derived from the complete intent, preserving retries.
  const digest = createHash("sha256")
    .update(JSON.stringify([orgId, userId, intent]))
    .digest("hex");
  const operationId =
    input.operationId ??
    (intent.sourceFileId
      ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
      : null);
  if (!operationId)
    throw new Error("Reserve an upload before transferring the PDF");
  let operation = await getDrawingUploadOperation(
    operationId,
    intent.projectId,
  );
  if (!operation && intent.sourceFileId)
    operation = await reserveDrawingUpload({ ...intent, operationId });
  if (!operation) throw new Error("Upload operation not found");
  const { fingerprint: _requestedFingerprint, ...requestedIntent } = intent;
  const { fingerprint: _reservedFingerprint, ...reservedIntent } = operation.intent;
  if (JSON.stringify(requestedIntent) !== JSON.stringify(reservedIntent)) {
    throw new Error("Upload intent does not match reservation");
  }
  const finish = startDrawingLifecycleStage("registration", { operationId });
  try {
    if (operation.status !== "registered") {
      if (input.generation && input.generation !== operation.generation)
        throw new Error("Upload generation expired");
      if (operation.status !== "reserved")
        throw new Error("Upload was cancelled or expired");
      let path = operation.storage_path;
      if (intent.sourceFileId) {
        const source = await supabase
          .from("files")
          .select("storage_path,size_bytes,mime_type")
          .eq("id", intent.sourceFileId)
          .eq("org_id", orgId)
          .eq("project_id", intent.projectId)
          .is("archived_at", null)
          .maybeSingle();
        if (
          source.error ||
          !source.data ||
          source.data.mime_type !== "application/pdf"
        )
          throw new Error("Source PDF not found");
        path = source.data.storage_path;
      } else if (input.storagePath !== path)
        throw new Error("Upload path does not match reservation");
      const object = await headDrawingPdfObject({
        orgId,
        path,
        resolveSource: Boolean(operation.intent.sourceFileId),
      });
      if (object.size !== operation.intent.fileSize)
        throw new Error("Uploaded PDF size mismatch");
      if (
        !operation.intent.sourceFileId &&
        (object.metadata?.["operation_id"] !== operation.id ||
          object.metadata?.["generation"] !== operation.generation ||
          (operation.intent.fingerprint &&
            object.metadata?.["content-identity"] !==
              operation.intent.fingerprint) ||
          (operation.transfer_id &&
            object.metadata?.["transfer-id"] !== operation.transfer_id))
      )
        throw new Error("Uploaded PDF identity does not match reservation");
      const { data, error } = await supabase.rpc("finalize_drawing_upload", {
        p_id: operationId,
        p_org_id: orgId,
        p_project_id: intent.projectId,
        p_user_id: userId,
        p_storage_path: path,
        p_generation: operation.generation,
        p_verified_size: object.size,
      });
      if (error) throw new Error(error.message);
      operation = operationSchema.parse(data);
    }
    if (!operation.drawing_set_id || !operation.revision_id)
      throw new Error("Upload receipt is incomplete");
    const set = await getDrawingSet(operation.drawing_set_id);
    if (!set) throw new Error("Drawing set unavailable");
    // Durable queue insertion already committed; a failed wake-up never changes registration success.
    void triggerDrawingsPipeline().catch(() => undefined);
    finish("success");
    return { set, draftRevisionId: operation.revision_id };
  } catch (error) {
    finish("failure");
    throw error;
  }
}
