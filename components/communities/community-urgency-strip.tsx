import Link from "next/link"

import type { CommunityUrgency } from "@/lib/services/community-portfolio"
import { cn } from "@/lib/utils"

const TONE = {
  critical: "border-destructive/50 text-destructive hover:bg-destructive/10",
  warning: "border-warning/50 text-warning hover:bg-warning/10",
  neutral: "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
} as const

/**
 * What needs somebody today, linking out to the desk that owns the fix. The
 * community displays these; holds, starts, and cutoffs are mutated on Sales,
 * Starts, and Design Studio respectively.
 */
export function CommunityUrgencyStrip({ urgencies }: { urgencies: CommunityUrgency[] }) {
  if (urgencies.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {urgencies.map((urgency) => (
        <Link
          key={urgency.kind}
          href={urgency.href}
          className={cn("border px-1.5 py-0.5 text-[11px] font-medium transition-colors", TONE[urgency.tone])}
        >
          {urgency.label}
        </Link>
      ))}
    </div>
  )
}
