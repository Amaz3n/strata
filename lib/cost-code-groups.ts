import type { CostCode } from "@/lib/types"
import type { ProjectPosture } from "@/lib/product-tier"

export type CostCodeStandardGroup = {
  standard: string
  label: string
  codes: CostCode[]
}

const STANDARD_LABELS: Record<string, string> = {
  csi: "CSI MasterFormat",
  nahb: "NAHB",
  custom: "Custom",
}

export function groupCostCodesByStandard(
  costCodes: CostCode[],
  posture: ProjectPosture,
): CostCodeStandardGroup[] {
  const preferred = posture === "commercial" ? ["csi", "nahb", "custom"] : ["nahb", "csi", "custom"]
  const rank = new Map(preferred.map((standard, index) => [standard, index]))
  const groups = new Map<string, CostCode[]>()

  for (const code of costCodes) {
    const standard = code.standard || "custom"
    const group = groups.get(standard) ?? []
    group.push(code)
    groups.set(standard, group)
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => {
      const leftRank = rank.get(left) ?? preferred.length
      const rightRank = rank.get(right) ?? preferred.length
      return leftRank - rightRank || left.localeCompare(right)
    })
    .map(([standard, codes]) => ({
      standard,
      label: STANDARD_LABELS[standard] ?? standard.toUpperCase(),
      codes: codes.slice().sort((left, right) => left.code.localeCompare(right.code)),
    }))
}
