import { STAGE_ACCENT, STAGE_SHORT_LABELS, STAGE_TRACK } from "@/lib/sales/stages"
import type { SalesDealStage } from "@/lib/services/sales-deals"
import { cn } from "@/lib/utils"

/**
 * Where this buyer is on the seven-stage track, at the width of the page.
 *
 * Built to the funnel bar's rhythm on purpose — equal cells, one rule, colour
 * carried by the stage accent — so the deal file reads as the same instrument
 * as the board it was opened from. Every cell renders the identical two rows
 * whatever its state, which is what keeps the row from going ragged.
 *
 * A lost deal has rank 0 and never renders here: an empty track tells the
 * consultant nothing, so the file prints the reason instead.
 */
export function DealStageTrack({ stage, stageRank }: { stage: SalesDealStage; stageRank: number }) {
  const accent = STAGE_ACCENT[stage]
  const settled = stageRank === STAGE_TRACK.length

  return (
    <ol className="flex divide-x border-b" aria-label="Deal stage">
      {STAGE_TRACK.map((step, index) => {
        const position = index + 1
        const done = position < stageRank
        const current = position === stageRank

        return (
          <li
            key={step}
            aria-current={current ? "step" : undefined}
            className={cn("min-w-0 flex-1", current && "bg-muted/40")}
          >
            <span
              aria-hidden="true"
              className={cn(
                "block h-1 w-full",
                done && "bg-success",
                current && (settled ? "bg-success" : accent.bar),
                !done && !current && "bg-muted",
              )}
            />
            <span
              className={cn(
                "block truncate px-2 py-2 text-center text-[10px] font-medium tracking-wider uppercase",
                current ? cn("font-semibold", settled ? "text-success" : accent.text) : null,
                done && "text-foreground/60",
                !done && !current && "text-muted-foreground/50",
              )}
            >
              {STAGE_SHORT_LABELS[step]}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
