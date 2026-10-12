import { Badge } from "@/components/ui/badge"
import { LAND_DEAL_STAGE_LABELS, type LandDealStage } from "@/lib/land/diligence"
import { cn } from "@/lib/utils"

import { STAGE_TONE } from "./land-format"

export function LandDealStageBadge({ stage }: { stage: LandDealStage }) {
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium uppercase tracking-wide", STAGE_TONE[stage])}>
      {LAND_DEAL_STAGE_LABELS[stage]}
    </Badge>
  )
}
