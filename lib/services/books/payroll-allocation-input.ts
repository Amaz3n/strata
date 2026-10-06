/** Exact decimal dollars for allocation inputs; never rounds floating point. */
export function payrollAllocationInputCents(input: string): number {
  const text = input.trim();
  if (text.length > 24 || !/^(0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text))
    throw new Error(
      "Enter an exact nonnegative dollar amount with at most two decimal places",
    );
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0")));
  if (!Number.isSafeInteger(cents))
    throw new Error("Payroll amount exceeds exact integer cents");
  return cents;
}
export function payrollAllocationInputText(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0)
    throw new Error("Payroll amount must be exact nonnegative integer cents");
  const value = BigInt(cents);
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

/** Signed dollar inputs for actual prior events and their refunds/reversals. */
export function payrollClaimInputCents(input: string): number {
  const text = input.trim(),
    negative = text.startsWith("-");
  const amount = payrollAllocationInputCents(negative ? text.slice(1) : text);
  if (amount === 0) throw Error("A payroll source-line claim must be nonzero");
  return negative ? -amount : amount;
}
