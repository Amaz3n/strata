import { z } from "zod"
import { booksDigest } from "./hash"
import { payrollPostingPlan } from "./payroll-posting-plan"

const uuid = z.string().uuid().toLowerCase(), notes = z.string().trim().min(10).max(4000), timestamp = z.string().datetime({ offset: true })
export const payrollPostingProposalRecordSchema = z.object({
  id: uuid, org_id: uuid, payroll_import_id: uuid, payment_review_id: uuid.nullable(), status: z.enum(["draft", "reviewed", "withdrawn"]),
  plan: z.record(z.unknown()), plan_digest: z.string().regex(/^[a-f0-9]{64}$/), prepared_by: uuid, prepared_at: timestamp, preparation_notes: notes,
  reviewed_by: uuid.nullable(), reviewed_at: timestamp.nullable(), review_notes: notes.nullable(),
  withdrawn_by: uuid.nullable(), withdrawn_at: timestamp.nullable(), withdrawal_reason: z.string().trim().min(10).nullable(), idempotency_key: z.string().trim().min(10).max(200),
}).strict()

/** Historical replay preserves the reviewed source versions after withdrawal.
 * Reconstructing prior reviewed status here confers no current posting authority.
 */
function historicalReviewed(input: unknown) {
  const row = z.object({ status: z.enum(["reviewed", "withdrawn"]), reviewed_by: uuid, reviewed_at: timestamp, review_notes: notes,
    withdrawn_by: uuid.nullable(), withdrawn_at: timestamp.nullable(), withdrawal_reason: z.string().trim().min(10).nullable(),
  }).passthrough().parse(input)
  if (row.status === "withdrawn" ? row.withdrawn_by === null || row.withdrawn_at === null || row.withdrawal_reason === null : row.withdrawn_by !== null || row.withdrawn_at !== null || row.withdrawal_reason !== null) throw new Error("Payroll proposal source withdrawal history differs")
  return { ...row, status: "reviewed", withdrawn_by: null, withdrawn_at: null, withdrawal_reason: null }
}
export function parsePayrollPostingProposal(input: unknown, parentInput: unknown, paymentInput: unknown | null) {
  const row = payrollPostingProposalRecordSchema.parse(input)
  const parent = historicalReviewed(parentInput), payment = paymentInput === null ? null : historicalReviewed(paymentInput)
  const plan = payrollPostingPlan(parent, payment)
  if (row.org_id !== plan.orgId || row.payroll_import_id !== plan.runId || row.payment_review_id !== plan.paymentReviewId || row.plan_digest !== plan.digest || booksDigest(row.plan) !== booksDigest(plan)) throw new Error("Payroll posting proposal differs from original reviewed sources and dated journal plan")
  const parentRecord = z.record(z.unknown()).parse(parentInput), paymentRecord = paymentInput === null ? null : z.record(z.unknown()).parse(paymentInput)
  const hasReview = row.reviewed_by !== null
  if (hasReview ? row.reviewed_by === row.prepared_by || row.reviewed_by === parentRecord.prepared_by || row.reviewed_by === paymentRecord?.prepared_by || row.reviewed_at === null || row.review_notes === null || row.status === "draft" : row.reviewed_at !== null || row.review_notes !== null || row.status === "reviewed") throw new Error("Payroll posting proposal lacks independent complete review history")
  if (row.status === "withdrawn" ? row.withdrawn_by === null || row.withdrawn_at === null || row.withdrawal_reason === null : row.withdrawn_by !== null || row.withdrawn_at !== null || row.withdrawal_reason !== null) throw new Error("Payroll posting proposal withdrawal history differs")
  if ((parentRecord.status === "withdrawn" || paymentRecord?.status === "withdrawn") && row.status !== "withdrawn") throw new Error("Payroll posting proposal retains active authority after source withdrawal")
  return { row, plan }
}
