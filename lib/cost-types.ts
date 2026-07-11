export const COST_TYPES = ["labor", "material", "equipment", "subcontract", "other"] as const

export type CostType = (typeof COST_TYPES)[number]

export const COST_TYPE_LABELS: Record<CostType, string> = {
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  subcontract: "Subcontract",
  other: "Other",
}

export function isCostType(value: unknown): value is CostType {
  return COST_TYPES.some((costType) => costType === value)
}
