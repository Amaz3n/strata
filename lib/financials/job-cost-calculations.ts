type ExpenseCostMetadata = {
  source?: unknown;
  qbo_signed_amount_cents?: unknown;
} | null;

/**
 * Credits and refunds are stored with a positive amount and a `source` marking them
 * as a credit; they cost the job a negative amount. Splits inherit the parent
 * expense's sign.
 */
export function expenseCreditSign(metadata?: ExpenseCostMetadata): 1 | -1 {
  return String(metadata?.source ?? "").startsWith("expense_credit") ? -1 : 1;
}

/**
 * Job-cost amount for an expense header.
 *
 * `qbo_signed_amount_cents` is written by the QuickBooks importer for journal-entry
 * derived expenses, where the debit/credit direction — not the stored magnitude —
 * decides the sign.
 */
export function calculateExpenseCostCents(input: {
  amountCents: unknown;
  taxCents?: unknown;
  metadata?: ExpenseCostMetadata;
}): number {
  const signedAmountValue = input.metadata?.qbo_signed_amount_cents;
  const signedAmount = Number(signedAmountValue);
  if (
    String(input.metadata?.source ?? "") === "journal_entry" &&
    signedAmountValue != null &&
    Number.isFinite(signedAmount)
  ) {
    return Math.round(signedAmount);
  }

  const storedTotal = Math.round(
    Number(input.amountCents ?? 0) + Number(input.taxCents ?? 0),
  );
  return expenseCreditSign(input.metadata) === -1
    ? -Math.abs(storedTotal)
    : storedTotal;
}

export function calculateTimeEntryCostCents(entry: {
  cost_cents?: number | null;
  hours?: number | string | null;
  base_rate_cents?: number | null;
  burden_multiplier?: number | string | null;
  is_overtime?: boolean | null;
  ot_multiplier?: number | string | null;
  is_double_time?: boolean | null;
  dt_multiplier?: number | string | null;
}) {
  if (entry.cost_cents != null) return Number(entry.cost_cents);
  const premiumMultiplier = entry.is_double_time
    ? Number(entry.dt_multiplier ?? 2)
    : entry.is_overtime
      ? Number(entry.ot_multiplier ?? 1.5)
      : 1;
  return Math.round(
    Number(entry.hours ?? 0) *
      Number(entry.base_rate_cents ?? 0) *
      Number(entry.burden_multiplier ?? 1) *
      premiumMultiplier,
  );
}

/**
 * Allocate a header-level cost (for example accrued use tax) to detail lines by
 * absolute cost using the largest-remainder method. The stable id tie-breaker
 * makes the result deterministic, and the returned cents always add exactly to
 * the header amount.
 */
export function allocateAdditionalCostCents(
  additionalCents: number,
  lines: Array<{ id: string; amountCents: number }>,
): Map<string, number> {
  if (!Number.isInteger(additionalCents) || additionalCents < 0) {
    throw new Error(
      "Additional job cost must be a non-negative integer number of cents",
    );
  }
  if (new Set(lines.map((line) => line.id)).size !== lines.length) {
    throw new Error("Job-cost allocation lines must have unique ids");
  }
  if (lines.length === 0) {
    if (additionalCents === 0) return new Map();
    throw new Error(
      "Additional job cost cannot be allocated without detail lines",
    );
  }
  const weighted = lines.map((line) => {
    if (!Number.isInteger(line.amountCents))
      throw new Error("Job-cost allocation line amounts must be integer cents");
    return { ...line, weight: Math.abs(line.amountCents) };
  });
  const totalWeight = weighted.reduce((sum, line) => sum + line.weight, 0);
  if (totalWeight === 0) {
    const allocation = new Map(lines.map((line) => [line.id, 0]));
    allocation.set(
      [...lines].sort((left, right) => left.id.localeCompare(right.id))[0].id,
      additionalCents,
    );
    return allocation;
  }
  const shares = weighted.map((line) => {
    const numerator = additionalCents * line.weight;
    return {
      id: line.id,
      cents: Math.floor(numerator / totalWeight),
      remainder: numerator % totalWeight,
    };
  });
  let remaining =
    additionalCents - shares.reduce((sum, share) => sum + share.cents, 0);
  for (const share of [...shares].sort(
    (left, right) =>
      right.remainder - left.remainder || left.id.localeCompare(right.id),
  )) {
    if (remaining === 0) break;
    share.cents += 1;
    remaining -= 1;
  }
  return new Map(shares.map((share) => [share.id, share.cents]));
}
