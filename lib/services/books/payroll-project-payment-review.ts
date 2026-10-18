import "server-only";
import { z } from "zod";
import {
  getProjectPayrollDraftDetail,
  requireProjectPayrollImportScope,
} from "./payroll-draft-workspace";
import {
  canonicalPayrollPaymentReviewRequest,
  payrollPaymentReviewRequestSchema,
} from "./payroll-payment-review-rules";
import {
  previewPayrollPaymentReview,
  preparePayrollPaymentReview,
} from "./payroll-payment-reviews";
const inputSchema = z
  .object({
    projectId: z.string().uuid().toLowerCase(),
    request: payrollPaymentReviewRequestSchema,
  })
  .strict();
/** The project read applies whole-organization accounting authorization and
 * enabled-module checks before any document byte reads or attribution writes. */
export async function previewProjectPayrollPaymentReview(input: unknown) {
  const args = inputSchema.parse(input),
    request = canonicalPayrollPaymentReviewRequest(args.request);
  await getProjectPayrollDraftDetail({
    projectId: args.projectId,
    importId: request.payroll_import_id,
  });
  return previewPayrollPaymentReview({ request });
}
export async function prepareProjectPayrollPaymentReview(input: unknown) {
  const args = inputSchema
    .extend({
      notes: z.string().trim().min(10).max(4000),
      idempotencyKey: z.string().trim().min(10).max(200),
      expectedEvidenceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .parse(input);
  const request = canonicalPayrollPaymentReviewRequest(args.request);
  await requireProjectPayrollImportScope(
    args.projectId,
    request.payroll_import_id,
  );
  return preparePayrollPaymentReview({
    request,
    notes: args.notes,
    idempotencyKey: args.idempotencyKey,
    expectedEvidenceDigest: args.expectedEvidenceDigest,
  });
}
