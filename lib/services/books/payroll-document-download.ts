import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { requirePrivatePayrollRead } from "@/lib/storage/payroll-private-storage";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { isPayrollDocumentPrivate } from "./payroll-document-access";
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules";
import { stageVerifiedTaxAttachment } from "./tax-attachments";

export class PayrollDocumentDownloadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function downloadPrivatePayrollDocument(
  fileId: string,
  versionId: string,
  signal?: AbortSignal,
) {
  const uuid = z.string().uuid().toLowerCase();
  if (!uuid.safeParse(fileId).success || !uuid.safeParse(versionId).success)
    throw new PayrollDocumentDownloadError(
      400,
      "Invalid payroll document request",
    );
  const c = await requireOrgContext();
  try {
    await requirePrivatePayrollRead(c.orgId);
  } catch {
    throw new PayrollDocumentDownloadError(
      403,
      "Organization-wide accounting access is required",
    );
  }
  const service = createServiceSupabaseClient();
  const f = await service
    .from("files")
    .select("id,org_id")
    .eq("org_id", c.orgId)
    .eq("id", uuid.parse(fileId))
    .single();
  const v = await service
    .from("doc_versions")
    .select("*")
    .eq("org_id", c.orgId)
    .eq("id", uuid.parse(versionId))
    .eq("file_id", uuid.parse(fileId))
    .single();
  if (
    f.error ||
    v.error ||
    !f.data ||
    !v.data ||
    f.data.org_id !== c.orgId ||
    v.data.org_id !== c.orgId
  )
    throw new PayrollDocumentDownloadError(
      404,
      "Payroll document is unavailable",
    );
  if (!(await isPayrollDocumentPrivate(c.orgId, v.data.storage_path)))
    throw new PayrollDocumentDownloadError(
      404,
      "Payroll document is unavailable",
    );
  const proof = taxAttachmentSnapshotSchema.parse({
    version: 1,
    org_id: c.orgId,
    file_id: uuid.parse(fileId),
    document_version_id: uuid.parse(versionId),
    storage_path: v.data.storage_path,
    file_name: v.data.file_name,
    mime_type: v.data.mime_type,
    size_bytes: Number(v.data.size_bytes),
    checksum: v.data.checksum,
  });
  try {
    return {
      body: await stageVerifiedTaxAttachment(service, c.orgId, proof, signal),
      name: proof.file_name,
      size: proof.size_bytes,
    };
  } catch {
    throw new PayrollDocumentDownloadError(
      409,
      "Original payroll document is unavailable or differs from its retained version",
    );
  }
}
