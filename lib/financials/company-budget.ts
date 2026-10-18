/** Parse a nonnegative dollar input without accepting exponents or fractional cents. */
export function parseBudgetCents(value: string): number {
  if (!/^\d*(\.\d{0,2})?$/.test(value)) return NaN;
  const cents = Math.round(Number(value) * 100);
  return Number.isSafeInteger(cents) ? cents : NaN;
}

/** Put remainder cents in the first months so the annual plan stays exact. */
export function spreadAnnualBudget(cents: number): number[] {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error("Invalid annual budget");
  return Array.from(
    { length: 12 },
    (_, index) => Math.floor(cents / 12) + (index < cents % 12 ? 1 : 0),
  );
}
