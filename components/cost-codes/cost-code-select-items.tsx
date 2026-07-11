"use client"

import type { CostCode } from "@/lib/types"
import { groupCostCodesByStandard } from "@/lib/cost-code-groups"
import { getProjectPosture } from "@/lib/product-tier"
import { usePageTitle } from "@/components/layout/page-title-context"
import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select"

export function CostCodeSelectItems({ costCodes }: { costCodes: CostCode[] }) {
  const { productTier, projectContext } = usePageTitle()
  const posture = projectContext?.posture ?? getProjectPosture(undefined, productTier)
  const groups = groupCostCodesByStandard(costCodes, posture)

  return groups.map((group) => (
    <SelectGroup key={group.standard}>
      <SelectLabel>{group.label}</SelectLabel>
      {group.codes.map((code) => (
        <SelectItem key={code.id} value={code.id}>
          {code.code ? `${code.code} — ${code.name}` : code.name}
        </SelectItem>
      ))}
    </SelectGroup>
  ))
}
