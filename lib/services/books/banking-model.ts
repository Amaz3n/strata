import { z } from "zod";

export const bankCodingLineSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  costCodeId: z.string().uuid().nullable(),
  amountCents: z.number().int().nonnegative().safe(),
});
export const bankCodingSchema = z.object({
  vendorId: z.string().uuid().nullable().default(null),
  memo: z.string().max(200).default(""),
  receiptStatus: z
    .enum(["missing", "requested", "not_required"])
    .default("missing"),
  learn: z.boolean().default(false),
  lines: z.array(bankCodingLineSchema).min(1).max(50),
});
export type BankCoding = z.infer<typeof bankCodingSchema>;

/**
 * A single coding line represents the whole transaction. Its amount is derived
 * from the bank transaction so a former split cannot leave a stale remainder
 * behind after the other lines are removed.
 */
export function codingForTransactionTotal(
  coding: BankCoding,
  amountCents: number,
): BankCoding {
  if (
    coding.lines.length !== 1 ||
    coding.lines[0].amountCents === amountCents
  )
    return coding;
  return {
    ...coding,
    lines: [{ ...coding.lines[0], amountCents }],
  };
}
export type BankingStatus = "review" | "posted" | "excluded" | "pending";
export function bankStatus(transaction: {
  lifecycle_status: string;
  excluded: boolean;
  amount_cents: number;
  matches: Array<{
    status: string;
    matched_amount_cents: number;
    match_type: string;
  }>;
}): BankingStatus {
  if (transaction.excluded) return "excluded";
  if (transaction.lifecycle_status === "pending") return "pending";
  const matched = transaction.matches
    .filter((m) => m.status === "confirmed" && m.match_type !== "excluded")
    .reduce((sum, m) => sum + Number(m.matched_amount_cents), 0);
  return matched >= transaction.amount_cents ? "posted" : "review";
}
export function codingProblem(
  coding: BankCoding,
  amountCents: number,
  accounts: Array<{ id: string; account_type: string }>,
): string | null {
  if (coding.lines.some((line) => !line.accountId || line.amountCents <= 0))
    return "Choose a category and positive amount for every line.";
  if (
    coding.lines.reduce((sum, line) => sum + line.amountCents, 0) !==
    amountCents
  )
    return "Split amounts must equal the transaction total.";
  for (const line of coding.lines) {
    const account = accounts.find((account) => account.id === line.accountId);
    if (!account) return "Choose an active category.";
    if (account.account_type === "cogs" && !line.projectId)
      return "Choose a project for direct job costs.";
    if (account.account_type === "expense" && line.projectId)
      return "Use a direct cost category for project spending.";
    if (line.costCodeId && !line.projectId)
      return "A cost code requires a project.";
  }
  return null;
}
export function similarBankTransactions(
  a: {
    bank_account_id: string;
    direction: string;
    merchant_name: string | null;
    description: string;
    amount_cents: number;
  },
  b: typeof a,
) {
  const normalize = (value: string) =>
    value.trim().toLowerCase().replace(/\s+/g, " ");
  return (
    a.bank_account_id === b.bank_account_id &&
    a.direction === b.direction &&
    a.amount_cents === b.amount_cents &&
    !!a.merchant_name &&
    normalize(a.merchant_name) === normalize(b.merchant_name ?? "") &&
    normalize(a.description) === normalize(b.description)
  );
}
export function receiptCandidates(
  receipt: {
    totalDollars: number | null;
    vendorName: string | null;
    expenseDate: string | null;
  },
  transactions: Array<{
    id: string;
    amount_cents: number;
    merchant_name: string | null;
    description: string;
    transaction_date: string;
  }>,
) {
  if (receipt.totalDollars == null || !receipt.expenseDate) return [];
  const cents = Math.round(Math.abs(receipt.totalDollars) * 100);
  const vendor = receipt.vendorName?.trim().toLowerCase();
  return transactions
    .filter(
      (t) =>
        t.amount_cents === cents &&
        Math.abs(
          Date.parse(t.transaction_date) - Date.parse(receipt.expenseDate!),
        ) <=
          7 * 86400000,
    )
    .map((t) => ({
      id: t.id,
      strong:
        !!vendor &&
        (t.merchant_name ?? t.description).toLowerCase().includes(vendor),
    }));
}
