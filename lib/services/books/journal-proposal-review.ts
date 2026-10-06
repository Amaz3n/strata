import { z } from "zod";

const exactCents = z
  .union([
    z.number().int().nonnegative().safe(),
    z.string().regex(/^(0|[1-9][0-9]*)$/),
  ])
  .transform((value) => BigInt(value).toString());
export const journalProposalCursorSchema = z.object({
  proposedAt: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/,
    ),
  id: z.string().uuid(),
});
export type JournalProposalCursor = z.infer<typeof journalProposalCursorSchema>;
const person = z.object({
  full_name: z.string().nullable(),
  email: z.string().nullable(),
});
export const pendingJournalProposalSchema = z.object({
  id: z.string().uuid(),
  entry_date: z.string(),
  memo: z.string(),
  reversing_on: z.string().nullable(),
  policy_version: z.number().int().positive(),
  status: z.literal("pending"),
  proposed_by: z.string().uuid(),
  proposed_at: z.string(),
  proposer: z.union([person, z.array(person), z.null()]),
  lines: z
    .array(
      z.object({
        line_no: z.number().int().positive(),
        account_id: z.string().uuid(),
        account_code: z.string().optional(),
        project_id: z.string().uuid().nullish(),
        company_id: z.string().uuid().nullish(),
        description: z.string().nullish(),
        debit_cents: exactCents,
        credit_cents: exactCents,
        dimensions: z.record(z.string(), z.unknown()).nullish(),
      }),
    )
    .min(2)
    .max(1000),
});
export type PendingJournalProposal = z.infer<
  typeof pendingJournalProposalSchema
>;
export function proposalReviewTotals(lines: PendingJournalProposal["lines"]) {
  const debit = lines.reduce((sum, line) => sum + BigInt(line.debit_cents), 0n);
  const credit = lines.reduce(
    (sum, line) => sum + BigInt(line.credit_cents),
    0n,
  );
  return {
    debit: debit.toString(),
    credit: credit.toString(),
    balanced:
      debit === credit &&
      debit > 0n &&
      lines.every(
        (line) =>
          (BigInt(line.debit_cents) > 0n && BigInt(line.credit_cents) === 0n) ||
          (BigInt(line.credit_cents) > 0n && BigInt(line.debit_cents) === 0n),
      ),
  };
}
export function formatProposalCents(value: string) {
  const cents = BigInt(value);
  return `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
}
