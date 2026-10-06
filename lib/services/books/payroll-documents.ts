import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  payrollRegisterHeaders,
  inspectPayrollRegisterCsv,
} from "./payroll-register-csv";
import {
  assertPrivatePayrollStorageConfigured,
  createPrivatePayrollUploadUrl,
  requirePrivatePayrollRead,
  readPrivatePayrollRegisterObject,
} from "@/lib/storage/payroll-private-storage";
const uuid = z.string().uuid().toLowerCase();
const uploadSchema = z
  .object({
    projectId: uuid,
    fileId: uuid,
    documentVersionId: uuid,
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/\.csv$/i),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const resultSchema = uploadSchema.omit({ projectId: true });

/** Direct, create-only private bucket upload avoids API body limits. A metadata
 * reservation is not verified provider evidence; finalize and import reread bytes. */
export async function preparePrivatePayrollUpload(input: unknown) {
  const args = uploadSchema.parse(input),
    context = await requireOrgContext(),
    c = await requirePrivatePayrollRead(context.orgId);
  assertPrivatePayrollStorageConfigured();
  const service = createServiceSupabaseClient(),
    project = await service
      .from("projects")
      .select("id,org_id")
      .eq("org_id", c.orgId)
      .eq("id", args.projectId)
      .single();
  if (project.error || !project.data || project.data.org_id !== c.orgId)
    throw new Error("Project is unavailable in this organization");
  const path = `${c.orgId}/books/payroll-private/${args.fileId}/source.csv`;
  const r = await service.rpc("commit_books_private_payroll_document", {
    p_org_id: c.orgId,
    p_file_id: args.fileId,
    p_version_id: args.documentVersionId,
    p_actor_id: c.userId,
    p_name: args.fileName,
    p_size: args.sizeBytes,
    p_checksum: args.checksum,
    p_path: path,
  });
  if (r.error)
    throw new Error(`Payroll upload preparation failed: ${r.error.message}`);
  const saved = resultSchema.parse(r.data);
  if (
    (Object.keys(saved) as (keyof typeof saved)[]).some(
      (key) => saved[key] !== args[key],
    )
  )
    throw new Error("Payroll upload reservation identity differs");
  const signed = await createPrivatePayrollUploadUrl({
    orgId: c.orgId,
    path,
    size: args.sizeBytes,
    checksum: args.checksum,
  });
  return { ...saved, ...signed };
}

/** Only byte-verified immutable document versions enter mapping and review. */
async function verifiedPrivatePayrollUpload(input: {
  fileId: string;
  documentVersionId: string;
}) {
  const c = await requireOrgContext();
  await requirePrivatePayrollRead(c.orgId);
  const fileId = uuid.parse(input.fileId),
    versionId = uuid.parse(input.documentVersionId),
    service = createServiceSupabaseClient();
  const f = await service
    .from("files")
    .select("*")
    .eq("org_id", c.orgId)
    .eq("id", fileId)
    .single();
  const v = await service
    .from("doc_versions")
    .select("*")
    .eq("org_id", c.orgId)
    .eq("id", versionId)
    .eq("file_id", fileId)
    .single();
  if (
    f.error ||
    v.error ||
    !f.data ||
    !v.data ||
    f.data.org_id !== c.orgId ||
    v.data.org_id !== c.orgId ||
    f.data.metadata?.books_private_kind !== "payroll_register" ||
    f.data.current_version_id !== versionId
  )
    throw new Error("Private payroll document version is unavailable");
  const saved = resultSchema.parse({
    fileId,
    documentVersionId: versionId,
    fileName: v.data.file_name,
    sizeBytes: Number(v.data.size_bytes),
    checksum: v.data.checksum,
  });
  if (
    f.data.storage_path !== v.data.storage_path ||
    f.data.checksum !== saved.checksum ||
    Number(f.data.size_bytes) !== saved.sizeBytes
  )
    throw new Error("Private payroll original metadata differs");
  const object = await readPrivatePayrollRegisterObject(
      c.orgId,
      v.data.storage_path,
    ),
    reader = object.body.getReader(),
    hash = createHash("sha256");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > saved.sizeBytes)
        throw new Error("Payroll upload original size differs");
      hash.update(chunk.value);
      chunks.push(chunk.value.slice());
    }
    if (
      size !== saved.sizeBytes ||
      hash.digest("hex") !== saved.checksum ||
      object.metadata?.arc_org_id !== c.orgId ||
      object.metadata?.arc_actor_id !== f.data.uploaded_by
    )
      throw new Error("Payroll upload original bytes or actor differ");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return {
    saved,
    text: new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    ),
  };
}

export async function finalizePrivatePayrollUpload(input: {
  fileId: string;
  documentVersionId: string;
}) {
  return (await verifiedPrivatePayrollUpload(input)).saved;
}

export async function inspectPrivatePayrollUpload(input: {
  fileId: string;
  documentVersionId: string;
  mapping?: unknown;
}) {
  const { saved, text } = await verifiedPrivatePayrollUpload(input);
  return {
    document: saved,
    headers: payrollRegisterHeaders(text),
    register:
      input.mapping == null
        ? null
        : inspectPayrollRegisterCsv(text, input.mapping),
  };
}

export async function inspectProjectPrivatePayrollUpload(input: {
  projectId: string;
  fileId: string;
  documentVersionId: string;
  mapping?: unknown;
}) {
  const context = await requireOrgContext();
  await requirePrivatePayrollRead(context.orgId);
  const project = await createServiceSupabaseClient()
    .from("projects")
    .select("id,org_id")
    .eq("org_id", context.orgId)
    .eq("id", uuid.parse(input.projectId))
    .single();
  if (project.error || !project.data || project.data.org_id !== context.orgId)
    throw new Error("Project is unavailable in this organization");
  return inspectPrivatePayrollUpload(input);
}
