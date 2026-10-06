import "server-only";
import { z } from "zod";
import { requireBooksWorkspaceEnabled } from "./module";
import { requireBooksAuthorization } from "./access";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { readBooksLegacyEntityProposal } from "./legacy-entity-ownership-service";
import { parseLegacyOwnershipPopulation } from "./legacy-entity-ownership";
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules";
import { stageVerifiedTaxAttachment } from "./tax-attachments";

export class EntityEvidenceDownloadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Deliver the selected frozen original, never a document's current pointer. */
export async function downloadBooksEntityEvidence(
  entityId: string,
  proposalId: string,
  versionId: string,
  signal?: AbortSignal,
) {
  const request = z
    .object({
      entityId: z.string().uuid(),
      proposalId: z.string().uuid(),
      versionId: z.string().uuid(),
    })
    .safeParse({ entityId, proposalId, versionId });
  if (!request.success)
    throw new EntityEvidenceDownloadError(
      400,
      "Invalid original evidence request",
    );
  [entityId, proposalId, versionId] = [entityId, proposalId, versionId].map(
    (id) => id.toLowerCase(),
  );
  const c = await requireBooksWorkspaceEnabled();
  const service = createServiceSupabaseClient();
  async function authorize() {
    try {
      for (const permission of ["books.read", "books.export"] as const)
        await requireBooksAuthorization({
          permission,
          orgId: c.orgId,
          userId: c.userId,
          supabase: c.supabase,
          resourceType: "legal_entity",
          resourceId: entityId,
          logDecision: true,
        });
      const gate = await service.rpc("assert_books_legacy_entity_operation", {
        p_org: c.orgId,
        p_entity: entityId,
        p_actor: c.userId,
        p_operation: "read",
      });
      if (gate.error || gate.data !== true)
        throw new Error("Access was not confirmed");
    } catch {
      throw new EntityEvidenceDownloadError(
        403,
        "Entity evidence access is required",
      );
    }
  }
  await authorize();
  let proof;
  try {
    const detail = await readBooksLegacyEntityProposal({
      entityId,
      proposalId,
    });
    const p = detail.proposal;
    if (
      p.org_id !== c.orgId ||
      p.legal_entity_id !== entityId ||
      p.id !== proposalId ||
      !p.decision_evidence.document_version_ids.includes(versionId)
    )
      throw new Error("Original is outside proposal");
    const population = parseLegacyOwnershipPopulation(p);
    const rows = population.doc_versions.filter(
      (row) => row.id === versionId && row.org_id === c.orgId,
    );
    if (rows.length !== 1) throw new Error("Original version is unavailable");
    const row = rows[0];
    if (
      !population.files.some(
        (file) => file.id === row.file_id && file.org_id === c.orgId,
      )
    )
      throw new Error("Original file is unavailable");
    proof = taxAttachmentSnapshotSchema.parse({
      version: 1,
      org_id: c.orgId,
      file_id: row.file_id,
      document_version_id: row.id,
      storage_path: row.storage_path,
      file_name: row.file_name,
      mime_type: row.mime_type ?? null,
      size_bytes: row.size_bytes == null ? undefined : Number(row.size_bytes),
      checksum: row.checksum,
    });
  } catch {
    throw new EntityEvidenceDownloadError(
      409,
      "Retained original evidence could not be verified",
    );
  }
  let body;
  try {
    body = await stageVerifiedTaxAttachment(service, c.orgId, proof, signal);
  } catch {
    throw new EntityEvidenceDownloadError(
      409,
      "Original evidence is unavailable or differs from the retained version",
    );
  }
  try {
    // Large originals may take time to verify. Recheck current authority before
    // releasing the staged bytes; failed authority must also remove staging.
    await authorize();
    signal?.throwIfAborted();
  } catch (error) {
    await body.cancel().catch(() => {});
    throw error;
  }
  return {
    body,
    name: proof.file_name,
    size: proof.size_bytes,
    checksum: proof.checksum,
  };
}
