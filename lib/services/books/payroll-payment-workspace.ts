import "server-only";
import { z } from "zod";
import { requireOrgContext } from "@/lib/services/context";
import { createServiceSupabaseClient } from "@/lib/supabase/server";
import {
  requireProjectPayrollImportScope,
  payrollDraftCursorSchema,
} from "./payroll-draft-workspace";
import { payrollEvidenceFromRecord } from "./payroll-register-request";
import { parsePayrollPaymentReviewEvidence } from "./payroll-payment-review-rules";
import {
  reviewPayrollPaymentReview,
  withdrawPayrollPaymentReview,
} from "./payroll-payment-reviews";

const uuid = z.string().uuid().toLowerCase();
const inputSchema = z
  .object({
    projectId: uuid,
    importId: uuid,
    reviewId: uuid.optional(),
    cursor: payrollDraftCursorSchema.nullable().optional(),
  })
  .strict();
const metadataSchema = z.object({
  id: uuid,
  org_id: uuid,
  payroll_import_id: uuid,
  status: z.enum(["draft", "reviewed", "withdrawn"]),
  prepared_by: uuid,
  prepared_at: z.string(),
  preparation_notes: z.string(),
  reviewed_by: uuid.nullable(),
  reviewed_at: z.string().nullable(),
  review_notes: z.string().nullable(),
  withdrawn_by: uuid.nullable(),
  withdrawn_at: z.string().nullable(),
  withdrawal_reason: z.string().nullable(),
  evidence_digest: z.string().regex(/^[a-f0-9]{64}$/),
});
/** Retained history validates frozen arithmetic without reading current blobs or
 * implying current readiness. Review independently verifies those dependencies. */
export async function readProjectPayrollPaymentWorkspace(input: unknown) {
  const args = inputSchema.parse(input);
  await requireProjectPayrollImportScope(args.projectId, args.importId);
  const c = await requireOrgContext(),
    service = createServiceSupabaseClient();
  const parent = await service
    .from("books_payroll_imports")
    .select("*")
    .eq("org_id", c.orgId)
    .eq("id", args.importId)
    .single();
  if (
    parent.error ||
    !parent.data ||
    parent.data.id !== args.importId ||
    parent.data.org_id !== c.orgId
  )
    throw Error("Payroll parent is unavailable in organization");
  const evidence = payrollEvidenceFromRecord(parent.data);
  if (evidence.run.id !== args.importId || evidence.run.org_id !== c.orgId)
    throw Error("Payroll parent evidence identity differs");
  const r = await service.rpc("read_books_payroll_payment_workspace", {
    p_org_id: c.orgId,
    p_import_id: args.importId,
    p_review_id: args.reviewId ?? null,
    p_before_time: args.cursor?.preparedAt ?? null,
    p_before_id: args.cursor?.id ?? null,
    p_limit: 50,
  });
  if (r.error)
    throw Error(
      `Payroll attribution history could not load: ${r.error.message}`,
    );
  const page = z
    .object({
      orgId: z.literal(c.orgId),
      importId: z.literal(args.importId),
      reviews: z.array(z.record(z.unknown())).max(50),
      nextCursor: payrollDraftCursorSchema.nullable(),
      activeReviewId: uuid.nullable(),
      posted: z.boolean(),
    })
    .parse(r.data);
  const reviews = page.reviews.map((row) => {
    const m = metadataSchema.parse(row);
    if (m.org_id !== c.orgId || m.payroll_import_id !== args.importId)
      throw Error("Payroll attribution identity differs");
    const proof = parsePayrollPaymentReviewEvidence(
      evidence,
      row.request,
      row.evidence,
      m.evidence_digest,
    );
    if (proof.request.id !== m.id)
      throw Error("Payroll attribution proof identity differs");
    const activeParent =
      !page.posted && ["draft", "reviewed"].includes(parent.data.status);
    return {
      id: m.id,
      status: m.status,
      preparedBy: m.prepared_by,
      preparedAt: m.prepared_at,
      preparationNotes: m.preparation_notes,
      reviewedBy: m.reviewed_by,
      reviewedAt: m.reviewed_at,
      reviewNotes: m.review_notes,
      withdrawnBy: m.withdrawn_by,
      withdrawnAt: m.withdrawn_at,
      withdrawalReason: m.withdrawal_reason,
      evidenceDigest: m.evidence_digest,
      canReview:
        activeParent &&
        m.status === "draft" &&
        c.userId !== m.prepared_by &&
        c.userId !== parent.data.prepared_by,
      canWithdraw: activeParent && m.status !== "withdrawn",
      decisions: proof.request.decisions,
      components: proof.evidence.allocation_components,
      sourceLines: proof.evidence.source_line_claims,
      documents: proof.evidence.supporting_documents.map((d) => ({
        fileId: d.file_id,
        versionId: d.document_version_id!,
        name: d.file_name,
        checksum: d.checksum,
        sizeBytes: d.size_bytes,
      })),
    };
  });
  if (
    new Set(reviews.map((r) => r.id)).size !== reviews.length ||
    (args.reviewId && (reviews.length !== 1 || reviews[0].id !== args.reviewId))
  )
    throw Error("Payroll attribution page identity differs");
  return {
    projectId: args.projectId,
    importId: args.importId,
    reviews,
    nextCursor: page.nextCursor,
    activeReviewId: page.activeReviewId,
  };
}
const transitionSchema = inputSchema
  .omit({ cursor: true })
  .extend({ reviewId: uuid, notes: z.string().trim().min(10).max(4000) })
  .strict();
export async function reviewProjectPayrollPaymentAttribution(input: unknown) {
  const args = transitionSchema.parse(input);
  await readProjectPayrollPaymentWorkspace({
    projectId: args.projectId,
    importId: args.importId,
    reviewId: args.reviewId,
  });
  return reviewPayrollPaymentReview({ id: args.reviewId, notes: args.notes });
}
export async function withdrawProjectPayrollPaymentAttribution(input: unknown) {
  const args = transitionSchema.parse(input);
  await readProjectPayrollPaymentWorkspace({
    projectId: args.projectId,
    importId: args.importId,
    reviewId: args.reviewId,
  });
  return withdrawPayrollPaymentReview({
    id: args.reviewId,
    reason: args.notes,
  });
}
