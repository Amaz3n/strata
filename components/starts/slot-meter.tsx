import { cn } from "@/lib/utils"

/**
 * A week's start capacity as discrete squares: solid released, half targeted,
 * hollow open. Anything past the target renders in the destructive tone so an
 * overloaded week reads as overloaded rather than as a bigger number.
 */
export function SlotMeter({ target, released, targeted, className }: {
  target: number
  released: number
  targeted: number
  className?: string
}) {
  const filled = released + targeted
  const slots = Math.max(target, filled)
  if (slots === 0) {
    return <span className={cn("text-[10px] text-muted-foreground", className)}>No target</span>
  }
  return (
    <span
      className={cn("flex flex-wrap items-center gap-[3px]", className)}
      role="img"
      aria-label={`${released} released, ${targeted} targeted, of ${target} ${target === 1 ? "slot" : "slots"}`}
    >
      {Array.from({ length: Math.min(slots, 20) }, (_, index) => {
        const state = index >= target ? "over" : index < released ? "released" : index < filled ? "targeted" : "open"
        return <span aria-hidden className="lane-slot" data-state={state} key={index} />
      })}
    </span>
  )
}

/**
 * The division and org caps on a week, each as `name filled/target`. At the cap
 * reads as a warning (the next release needs a reason), past it as overloaded.
 */
export function ThroughputCaps({ caps, className }: {
  caps: Array<{ divisionId: string | null; scopeName: string; target: number; filled: number }>
  className?: string
}) {
  if (!caps.length) return null
  return (
    <ul className={cn("space-y-0.5", className)} aria-label="Throughput caps">
      {caps.map((cap) => (
        <li
          key={cap.divisionId ?? "org"}
          className={cn(
            "flex items-baseline justify-between gap-2 text-[10px] tabular-nums",
            cap.filled > cap.target ? "text-destructive" : cap.filled === cap.target ? "text-warning" : "text-muted-foreground",
          )}
          title={`${cap.filled} released or releasing against the ${cap.scopeName} cap of ${cap.target}`}
        >
          <span className="truncate">{cap.scopeName}</span>
          <span>{cap.filled}/{cap.target}</span>
        </li>
      ))}
    </ul>
  )
}
