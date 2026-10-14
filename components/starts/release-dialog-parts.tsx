import { AlertTriangle } from "@/components/icons"
import { formatDay } from "@/components/starts/start-card"
import type { ReleaseOverage } from "@/lib/services/starts"
import type { CloseImpact } from "@/lib/starts/close-impact"
import { cn } from "@/lib/utils"

const LIMIT_LABEL: Record<ReleaseOverage["limit"], string> = { community: "community", division: "division", org: "organization" }
/** Rows the impact table draws before it counts the rest. */
const IMPACT_ROWS = 8

/** Which start limit a release would break, and by how much, in one line each. */
export function OverageNotice({ overage }: { overage: ReleaseOverage }) {
  return (
    <div className="border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" />
        Over start target
      </p>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {overage.exceeded.map((entry) => (
          <li key={entry.limit}>
            The {LIMIT_LABEL[entry.limit]} target for the week of {formatDay(overage.targetWeek)} is {entry.target} {entry.target === 1 ? "start" : "starts"} and already has {entry.alreadyTargeted}. This would be #{entry.alreadyTargeted + 1}.
          </li>
        ))}
      </ul>
    </div>
  )
}

/** What a start date does to the closings buyers were promised. Late homes lead. */
export function CloseImpactTable({ impacts, className }: { impacts: CloseImpact[]; className?: string }) {
  if (!impacts.length) return null
  const shown = impacts.slice(0, IMPACT_ROWS)
  const late = impacts.filter((impact) => impact.daysLate > 0).length
  return (
    <div className={cn("grid gap-1.5", className)}>
      <p className={cn("text-[11px] font-medium uppercase tracking-wide", late ? "text-destructive" : "text-muted-foreground")}>
        {late ? `${late} promised ${late === 1 ? "closing" : "closings"} would slip` : "Promised closings hold"}
      </p>
      <table className="w-full border text-[11px] tabular-nums">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="px-2 py-1 font-medium">Home</th>
            <th className="px-2 py-1 text-right font-medium">Closing</th>
            <th className="px-2 py-1 text-right font-medium">Projected</th>
            <th className="px-2 py-1 text-right font-medium">Slack</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((impact) => (
            <tr key={impact.id} className="border-b last:border-b-0">
              <td className="px-2 py-1">{impact.lotLabel}</td>
              <td className="px-2 py-1 text-right">{formatDay(impact.closingDate)}</td>
              <td className="px-2 py-1 text-right">{formatDay(impact.projectedClose)}</td>
              <td className={cn("px-2 py-1 text-right font-medium", impact.daysLate > 0 ? "text-destructive" : "text-success")}>
                {impact.daysLate > 0 ? `${impact.daysLate}d late` : `${impact.slackDays}d`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {impacts.length > shown.length ? (
        <p className="text-[11px] text-muted-foreground">{impacts.length - shown.length} more with closings not shown, the ones with the most slack.</p>
      ) : null}
    </div>
  )
}
