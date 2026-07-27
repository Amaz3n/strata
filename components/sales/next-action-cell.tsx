import type { NextAction, NextActionTone } from "@/lib/sales/next-action"
import { cn } from "@/lib/utils"

const TONE_DOT: Record<NextActionTone, string> = {
  overdue: "bg-destructive",
  soon: "bg-warning",
  scheduled: "bg-primary",
  none: "bg-muted-foreground/40",
}

/**
 * One action, one date, one dot. Colour means lateness here and nothing else —
 * a scheduled closing worth $600k is not more urgent than a hold expiring today.
 */
export function NextActionCell({ action, className }: { action: NextAction; className?: string }) {
  const late = action.tone === "overdue"
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <span className={cn("mt-[6px] size-1.5 shrink-0 rounded-full", TONE_DOT[action.tone])} />
      <div className="min-w-0">
        <p className={cn("truncate text-[13px] font-medium", late && "text-destructive", action.tone === "none" && "text-muted-foreground")}>
          {action.label}
        </p>
        {action.detail ? (
          <p className={cn("truncate text-[11px] tabular-nums", late ? "text-destructive" : "text-muted-foreground")}>
            {action.detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}
