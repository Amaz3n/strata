import type { WorkspaceField } from "@/lib/mobile/workspace-catalog"
type Field = WorkspaceField & { value?: string }
const field = (key: string, label: string, kind: WorkspaceField["kind"] = "text", required = false): Field => ({ key, label, kind, required })

const choice = (key: string, label: string, options: string[]): Field => ({ ...field(key, label, "choice", true), options })
export const budgetDraftFields: Field[] = [
  choice("purpose", "Document type", ["budget", "preconstruction_agreement"]),
  field("title", "Title", "text", true), field("summary", "Scope summary", "multiline"),
  field("recipient_name", "Recipient name"), field("recipient_email", "Recipient email"), field("valid_until", "Valid until", "date"),
  choice("maturity", "Estimate maturity", ["conceptual", "design_development", "construction_ready"]),
  choice("billing_model", "Billing model", ["fixed_price", "cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials"]),
  field("fixed_fee", "Fixed builder fee ($)", "number"), field("gmp", "Guaranteed maximum price ($)", "number"), field("retainage_percent", "Retainage (%)", "number"),
  field("payment_terms", "Payment terms", "multiline"), field("allowance_policy", "Allowance policy", "multiline"), field("terms", "Additional terms", "multiline"),
  choice("contingency_treatment", "Contingency treatment", ["included_in_price", "builder_reserve", "owner_reserve"]),
  field("pricing_basis", "Pricing basis and assumptions", "multiline"), field("inclusions", "Inclusions", "multiline"), field("exclusions", "Exclusions", "multiline"),
  field("tax_rate", "Tax (%)", "number"), field("contingency_percent", "Contingency (%)", "number"),
  { ...field("lines", "Estimate Lines", "rows", true), fields: [field("description", "Description", "text", true), field("quantity", "Quantity", "number", true), field("unit", "Unit"), field("unit_price", "Unit cost ($)", "number", true), field("markup_pct", "Markup (%)", "number"), choice("is_optional", "Optional", ["false", "true"]), choice("is_allowance", "Allowance", ["false", "true"]), field("notes", "Notes", "multiline")] },
]
