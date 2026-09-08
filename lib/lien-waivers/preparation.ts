import type { PrepareWaiverInput } from "./invoice-waiver";
export function parseWaiverAmount(value: string): number {
  const clean = value.replaceAll(",", "").trim();
  if (!/^\d+(\.\d{0,2})?$/.test(clean)) return NaN;
  const [whole, fraction = ""] = clean.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}
export function formatWaiverAmount(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
export function editableWaiverValues(
  input: Pick<PrepareWaiverInput, "project_name" | "property_description" | "owner_name" | "claimant_name" | "customer_name" | "amount_cents" | "through_date" | "exceptions" | "signer_name" | "signer_title">,
): Record<string, string> {
  const date = new Date(`${input.through_date}T12:00:00Z`);
  return {
    project_name: input.project_name || "[Project]",
    property_address: input.property_description || "[Property]",
    owner_name: input.owner_name || "[Owner]",
    company_name: input.claimant_name || "[Company]",
    claimant_name: input.claimant_name || "[Claimant]",
    signer_title: input.signer_title || "[Title]",
    customer_name: input.customer_name || "[Customer]",
    amount: Number.isFinite(input.amount_cents)
      ? `$${formatWaiverAmount(input.amount_cents)}`
      : "[Amount]",
    through_date: Number.isFinite(date.getTime())
      ? date.toLocaleDateString("en-US", {
          month: "long",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        })
      : "[Work through date]",
    exceptions: input.exceptions || "None",
    signer_name: input.signer_name || "[Signer]",
    signed_date: "________________",
  };
}
