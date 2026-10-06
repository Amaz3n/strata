import { calculateEstimateTotals, type EstimateMoneyLine } from "@/lib/financials/estimate-totals"
/** Commercial intent travels with the estimate version and its executed document. */
export type EstimateCommercial = {
  brief_version?: number
  governing_documents?: import("@/lib/precon/pricing-basis").PricingFileReference[]
  drawing_revisions?: import("@/lib/precon/pricing-basis").PricingDrawingReference[]
  purpose: "budget" | "preconstruction_agreement" | "construction_agreement"
  maturity: "conceptual" | "design_development" | "construction_ready"
  pricing_basis: string
  billing_model: "fixed_price" | "cost_plus_percent" | "cost_plus_fixed_fee" | "cost_plus_gmp" | "time_and_materials"
  fixed_fee_cents: number
  gmp_cents: number
  retainage_percent: number
  payment_terms: string
  allowance_policy: string
  contingency_treatment: "builder_reserve" | "owner_reserve" | "included_in_price"
}

export const DEFAULT_ESTIMATE_COMMERCIAL: EstimateCommercial = {
  purpose: "construction_agreement", maturity: "construction_ready", pricing_basis: "",
  billing_model: "fixed_price", fixed_fee_cents: 0, gmp_cents: 0, retainage_percent: 0,
  payment_terms: "", allowance_policy: "", contingency_treatment: "included_in_price",
}

export function normalizeEstimateCommercial(metadata?: Record<string, any> | null): EstimateCommercial {
  const value = metadata?.precon ?? {}
  return { ...DEFAULT_ESTIMATE_COMMERCIAL, ...value }
}

export function estimateCommercialIssues(value: EstimateCommercial, context: { totalCents?: number; hasAllowances?: boolean } = {}): string[] {
  if (value.purpose === "budget") return []
  const issues: string[] = []
  if (value.purpose === "construction_agreement" && value.maturity !== "construction_ready") issues.push("Resolve the estimate to construction-ready scope before issuing an agreement.")
  if (!value.pricing_basis.trim()) issues.push("Record the drawings, revisions and assumptions this price is based on.")
  if (!value.payment_terms.trim()) issues.push("Define payment timing, deposit and progress billing terms.")
  if (value.billing_model === "cost_plus_fixed_fee" && value.fixed_fee_cents <= 0) issues.push("Enter the fixed builder fee.")
  if (value.billing_model === "cost_plus_gmp" && value.gmp_cents <= 0) issues.push("Enter the guaranteed maximum price.")
  if (context.hasAllowances && !value.allowance_policy.trim()) issues.push("Define allowance inclusions and over/under reconciliation before issuing the agreement.")
  if (value.billing_model === "cost_plus_gmp" && (context.totalCents ?? 0) > value.gmp_cents) issues.push("The priced scope exceeds the GMP. Resolve scope, price or the guarantee before signing.")
  return issues
}

export function estimateCommercialText(metadata?: Record<string, any> | null): string {
  // Historical signed documents must not acquire terms after the fact.
  if (!metadata?.precon) return ""
  const value = normalizeEstimateCommercial(metadata)
  const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`
  return [
    value.purpose === "budget" ? "BUDGET REVIEW — Nonbinding approval of a planning basis only. This does not authorize construction or execute a construction agreement." : value.purpose === "preconstruction_agreement" ? "PRECONSTRUCTION SERVICES AGREEMENT — This agreement authorizes only the described preconstruction services. It does not authorize construction." : "CONSTRUCTION AGREEMENT",
    `Estimate maturity: ${value.maturity.replaceAll("_", " ")}`,
    value.pricing_basis && `Pricing basis: ${value.pricing_basis}`,
    `Commercial model: ${value.billing_model.replaceAll("_", " ")}`,
    value.billing_model !== "fixed_price" && "The displayed total is the current cost forecast. Actual reimbursable costs and fee are governed by these commercial terms; the stated GMP is the ceiling when applicable.",
    value.billing_model === "cost_plus_fixed_fee" && `Fixed builder fee: ${dollars(value.fixed_fee_cents)}`,
    value.billing_model === "cost_plus_gmp" && `Guaranteed maximum price: ${dollars(value.gmp_cents)}`,
    `Retainage: ${value.retainage_percent}%`,
    value.payment_terms && `Payment terms: ${value.payment_terms}`,
    value.allowance_policy && `Allowance basis and reconciliation: ${value.allowance_policy}`,
    `Contingency treatment: ${value.contingency_treatment.replaceAll("_", " ")}`,
  ].filter(Boolean).join("\n")
}

export function estimateDocumentTerms(metadata?: Record<string, any> | null, fallback?: string | null): string | null {
  const defaultTerms = normalizeEstimateCommercial(metadata).purpose === "budget" ? null : fallback
  return [estimateCommercialText(metadata), metadata?.terms ?? defaultTerms].filter(Boolean).join("\n\n") || null
}

/** A budget carries the range it was sent with; a signed price never has one. */
export function estimatePriceRange(metadata?: Record<string, any> | null): { lowCents: number; highCents: number } | null {
  const range = metadata?.pricing_worksheet?.range
  if (normalizeEstimateCommercial(metadata).purpose !== "budget") return null
  if (typeof range?.low_cents !== "number" || typeof range?.high_cents !== "number") return null
  return { lowCents: range.low_cents, highCents: range.high_cents }
}

export function canIssueEstimate(estimate: {status: string; is_current_version?: boolean | null; client_signed_at?: string | null; executed_at?: string | null}): boolean {
  return estimate.is_current_version !== false && !estimate.client_signed_at && !estimate.executed_at && ["draft", "sent", "changes_requested", "rejected"].includes(estimate.status)
}

export function estimateAlternateIssue(line: { is_optional?: boolean; unit_cost_cents?: number; metadata?: Record<string, any> | null }): string | null {
  const kind = line.metadata?.alternate_kind ?? "add"
  if (!["add", "deduct", "replacement"].includes(kind)) return "Choose a valid alternate treatment."
  if (!line.is_optional && kind !== "add" && !line.metadata?.accepted_budget_alternate) return "Deduct and replacement alternates must be optional or carried from accepted budget scope."
  if (kind === "deduct" && (line.unit_cost_cents ?? 0) >= 0) return "Enter a negative cost delta for a deduct alternate."
  if (kind === "replacement" && !String(line.metadata?.replacement_scope ?? "").trim()) return "Identify the base scope replaced by this alternate."
  if ((line.unit_cost_cents ?? 0) < 0 && !["deduct", "replacement"].includes(kind)) return "Negative costs require an explicit deduct or replacement alternate."
  return null
}

export function estimateLineNotes(metadata?: Record<string, any> | null): string | null {
  return [
    metadata?.alternate_kind === "deduct" && "Deduct alternate — credit to the base scope and price.",
    metadata?.alternate_kind === "replacement" && `Replacement alternate — replaces ${metadata.replacement_scope}. The amount is the net change to the base price, not a second full purchase.`,
    metadata?.notes,
  ].filter(Boolean).join("\n") || null
}


export function estimateBuilderFeeCents(metadata?: Record<string, any> | null): number {
  const value = normalizeEstimateCommercial(metadata)
  return value.billing_model === "cost_plus_fixed_fee" ? value.fixed_fee_cents : 0
}

export function normalizeCommercialEstimateLines<T extends EstimateMoneyLine>(lines: T[], commercial?: EstimateCommercial): T[] {
  return commercial?.billing_model === "cost_plus_fixed_fee" ? lines.map((line) => ({ ...line, markup_pct: 0 })) : lines
}

export function calculateCommercialEstimateTotals(lines: EstimateMoneyLine[], taxRate = 0, contingencyPct = 0, commercial?: EstimateCommercial) {
  const normalized = normalizeCommercialEstimateLines(lines, commercial)
  const fee = commercial?.billing_model === "cost_plus_fixed_fee" ? commercial.fixed_fee_cents : 0
  return calculateEstimateTotals(fee > 0 ? [...normalized, { quantity: 1, unit_cost_cents: fee, markup_pct: 0 }] : normalized, taxRate, contingencyPct)
}


/** Accepted budget options become priced base scope in the construction agreement. */
export function carryAcceptedBudgetScope<T extends { id: string; is_optional?: boolean; metadata?: Record<string, any> | null }>(lines: T[], acceptedIds: string[]) {
  const accepted = new Set(acceptedIds)
  return lines.filter((line) => !line.is_optional || accepted.has(line.id)).map((line) => ({
    ...line, is_optional: false, option_group: undefined,
    metadata: { ...line.metadata, is_optional: false, option_group: undefined, source_budget_item_id: line.id, accepted_budget_alternate: line.is_optional === true },
  }))
}
