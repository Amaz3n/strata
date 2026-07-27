import { STAGE_TRACK } from "@/lib/sales/stages"
import { cn } from "@/lib/utils"

/**
 * Seven segments, one per stage. Completed steps read green, the current step
 * reads primary. A lost deal (rank 0) shows an empty track — it went nowhere.
 */
export function StageMeter({ rank, className }: { rank: number; className?: string }) {
  return (
    <div className={cn("flex gap-0.5", className)} aria-hidden="true">
      {STAGE_TRACK.map((stage, index) => {
        const step = index + 1
        return (
          <span
            key={stage}
            className={cn(
              "h-1 w-4 shrink-0",
              step < rank && "bg-success",
              step === rank && (rank === STAGE_TRACK.length ? "bg-success" : "bg-primary"),
              step > rank && "bg-muted",
            )}
          />
        )
      })}
    </div>
  )
}
