import type { Company } from "@/lib/types"

/** Distinct, display-cased trade names from a company directory, sorted. */
export function tradeOptionsFromCompanies(companies: Company[]): string[] {
  const byNormalized = new Map<string, string>()
  for (const company of companies) {
    const trimmed = company.trade?.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (!byNormalized.has(key)) byNormalized.set(key, trimmed)
  }
  return Array.from(byNormalized.values()).sort((a, b) => a.localeCompare(b))
}
