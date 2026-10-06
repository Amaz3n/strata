/** Operative review amounts retain every cent, including the safe-integer limit. */
export function formatPayrollReviewCents(value: number): string {
  if (!Number.isSafeInteger(value))
    throw new Error("Payroll review amount is not exact integer cents");
  const signed = BigInt(value),
    absolute = signed < 0n ? -signed : signed;
  return `${signed < 0n ? "−" : ""}$${(absolute / 100n).toLocaleString("en-US")}.${String(absolute % 100n).padStart(2, "0")}`;
}
