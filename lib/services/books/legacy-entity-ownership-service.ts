import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { requireBooksAuthorization } from "./access";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { booksDigest } from "./hash";
import { taxAttachmentSnapshotSchema } from "./tax-attachment-rules";
import { verifyTaxAttachmentBytes } from "./tax-attachments";
import {
  legacyOwnershipDecisionSchema,
  legacyOwnershipProposalSchema,
  legacyOwnershipReviewSchema,
  parseLegacyOwnershipPopulation,
} from "./legacy-entity-ownership";
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const notes = z.string().trim().min(10).max(2000);
async function context(
  entityId: string,
  permission: "books.read" | "books.manage",
) {
  const c = await requireOrgContext();
  // Full retained source evidence includes the organization's private books.
  for (const p of [permission, "books.export"] as const)
    await requireBooksAuthorization({
      permission: p,
      orgId: c.orgId,
      userId: c.userId,
      supabase: c.supabase,
      resourceType: "legal_entity",
      resourceId: entityId,
      logDecision: true,
    });
  return c;
}
async function call(name: string, args: Record<string, unknown>) {
  const r = await createServiceSupabaseClient().rpc(name, args);
  if (r.error)
    throw new Error(
      `Legacy ownership review could not complete: ${r.error.message}`,
    );
  return r.data as unknown;
}
async function verifyDocuments(
  orgId: string,
  versions: Record<string, unknown>[],
  ids: string[],
) {
  const service = createServiceSupabaseClient();
  const proofs = [];
  for (const id of ids) {
    const rows = versions.filter(
      (row) => row.id === id && row.org_id === orgId,
    );
    if (rows.length !== 1)
      throw new Error("Original ownership supporting version is unavailable");
    const row = rows[0],
      proof = taxAttachmentSnapshotSchema.parse({
        version: 1,
        org_id: orgId,
        file_id: row.file_id,
        document_version_id: row.id,
        storage_path: row.storage_path,
        file_name: row.file_name,
        mime_type: row.mime_type ?? null,
        size_bytes: Number(row.size_bytes),
        checksum: row.checksum,
      });
    await verifyTaxAttachmentBytes(service, orgId, proof);
    proofs.push(proof);
  }
  return proofs;
}
export async function prepareBooksLegacyEntityProposal(input: unknown) {
  const v = z
      .object({
        id: uuid,
        entityId: uuid,
        profileId: uuid,
        previousReviewedProposalId: uuid.nullable(),
        accountingCutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        evidence: legacyOwnershipDecisionSchema,
        notes,
      })
      .strict()
      .parse(input),
    c = await context(v.entityId, "books.manage");
  const gate = await call("assert_books_legacy_entity_operation", {
    p_org: c.orgId,
    p_entity: v.entityId,
    p_actor: c.userId,
    p_operation: "prepare",
  });
  if (gate !== true)
    throw new Error("Legacy entity preparation access was not confirmed");
  // Only the selected original versions are streamed; a current file pointer or
  // a caller-supplied checksum cannot stand in for original documentary bytes.
  const response = await createServiceSupabaseClient()
    .from("doc_versions")
    .select(
      "id,org_id,file_id,storage_path,file_name,mime_type,size_bytes,checksum",
    )
    .eq("org_id", c.orgId)
    .in("id", v.evidence.document_version_ids);
  if (response.error)
    throw new Error("Original ownership supporting versions could not load");
  const before = await verifyDocuments(
    c.orgId,
    z.array(z.record(z.unknown())).parse(response.data),
    v.evidence.document_version_ids,
  );
  const p = legacyOwnershipProposalSchema.parse(
    await call("prepare_books_legacy_entity_proposal", {
      p_org: c.orgId,
      p_entity: v.entityId,
      p_id: v.id,
      p_actor: c.userId,
      p_profile: v.profileId,
      p_previous: v.previousReviewedProposalId,
      p_cutoff: v.accountingCutoff,
      p_evidence: v.evidence,
      p_notes: v.notes,
    }),
  );
  if (
    booksDigest([
      p.id,
      p.org_id,
      p.legal_entity_id,
      p.profile_id,
      p.previous_reviewed_proposal_id,
      p.accounting_cutoff,
      p.prepared_by,
      p.decision_evidence,
      p.preparation_notes,
    ]) !==
    booksDigest([
      v.id,
      c.orgId,
      v.entityId,
      v.profileId,
      v.previousReviewedProposalId,
      v.accountingCutoff,
      c.userId,
      v.evidence,
      v.notes,
    ])
  )
    throw new Error(
      "Legacy ownership preparation receipt differs from request",
    );
  const population = parseLegacyOwnershipPopulation(p),
    after = await verifyDocuments(
      c.orgId,
      population.doc_versions ?? [],
      p.decision_evidence.document_version_ids,
    );
  if (booksDigest(before) !== booksDigest(after))
    throw new Error(
      "Ownership document version changed while preparing; retain the original draft and prepare a current proposal",
    );
  return p;
}
export async function reviewBooksLegacyEntityProposal(input: unknown) {
  const v = z
      .object({ id: uuid, entityId: uuid, proposalId: uuid, notes })
      .strict()
      .parse(input),
    c = await context(v.entityId, "books.manage");
  const gate = await call("assert_books_legacy_entity_operation", {
    p_org: c.orgId,
    p_entity: v.entityId,
    p_actor: c.userId,
    p_operation: "review",
  });
  if (gate !== true)
    throw new Error("Legacy entity review access was not confirmed");
  const detail = z
    .object({
      proposal: legacyOwnershipProposalSchema,
      review: legacyOwnershipReviewSchema.nullable(),
    })
    .parse(
      await call("read_books_legacy_entity_proposal", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_proposal: v.proposalId,
        p_actor: c.userId,
      }),
    );
  if (
    detail.proposal.org_id !== c.orgId ||
    detail.proposal.legal_entity_id !== v.entityId ||
    detail.proposal.id !== v.proposalId
  )
    throw new Error("Legacy ownership preparation is outside request");
  // A committed approval retry returns the original SQL receipt; new approvals
  // must first prove the prepared original document bytes.
  if (!detail.review)
    await verifyDocuments(
      c.orgId,
      parseLegacyOwnershipPopulation(detail.proposal).doc_versions ?? [],
      detail.proposal.decision_evidence.document_version_ids,
    );
  const r = legacyOwnershipReviewSchema.parse(
    await call("review_books_legacy_entity_proposal", {
      p_org: c.orgId,
      p_entity: v.entityId,
      p_id: v.id,
      p_proposal: v.proposalId,
      p_actor: c.userId,
      p_notes: v.notes,
    }),
  );
  if (r.source_population_sha256 !== detail.proposal.source_population_sha256)
    throw new Error(
      "Legacy ownership review population differs from preparation",
    );
  if (
    booksDigest([
      r.id,
      r.org_id,
      r.legal_entity_id,
      r.proposal_id,
      r.reviewed_by,
      r.review_notes,
    ]) !==
    booksDigest([v.id, c.orgId, v.entityId, v.proposalId, c.userId, v.notes])
  )
    throw new Error("Legacy ownership review receipt differs from request");
  return r;
}
export async function readBooksLegacyEntityProposal(input: unknown) {
  const v = z
      .object({ entityId: uuid, proposalId: uuid })
      .strict()
      .parse(input),
    c = await context(v.entityId, "books.read");
  const r = z
    .object({
      proposal: legacyOwnershipProposalSchema,
      review: legacyOwnershipReviewSchema.nullable(),
      sourcePopulationCurrent: z.boolean(),
      approvedForLedgerActivation: z.literal(false),
    })
    .parse(
      await call("read_books_legacy_entity_proposal", {
        p_org: c.orgId,
        p_entity: v.entityId,
        p_proposal: v.proposalId,
        p_actor: c.userId,
      }),
    );
  if (
    r.proposal.org_id !== c.orgId ||
    r.proposal.legal_entity_id !== v.entityId ||
    r.proposal.id !== v.proposalId ||
    (r.review &&
      (r.review.org_id !== c.orgId ||
        r.review.legal_entity_id !== v.entityId ||
        r.review.proposal_id !== v.proposalId))
  )
    throw new Error("Legacy ownership detail receipt differs from request");
  parseLegacyOwnershipPopulation(r.proposal);
  return r;
}
