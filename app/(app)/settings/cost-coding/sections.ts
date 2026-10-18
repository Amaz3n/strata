export const COST_CODING_SECTIONS = [
  { key: "codes", label: "Cost codes" },
  { key: "markup", label: "Markup rules" },
  { key: "rates", label: "Billing rates" },
] as const

export function resolveCostCodingSection(value?: string | null) {
  return COST_CODING_SECTIONS.find(section => section.key === value)?.key ?? "codes"
}
