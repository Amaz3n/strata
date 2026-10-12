import Link from "next/link"

import { AGING_CLASS, dueLabel, formatDay } from "@/components/permits/permit-format"
import { Skeleton } from "@/components/ui/skeleton"
import { hasPermission } from "@/lib/services/permissions"
import { PERMIT_QUEUE_CAP, listPermitQueue, type PermitQueueRow } from "@/lib/services/permits"
import { cn } from "@/lib/utils"

function chase(row: PermitQueueRow) {
  const { response, decision, unresolvedRounds } = row.aging
  if (response) return { text: `Response ${dueLabel(response.daysOut).toLowerCase()}`, className: AGING_CLASS[response.state] }
  if (decision) return { text: `Decision ${dueLabel(decision.daysOut).toLowerCase()}`, className: AGING_CLASS[decision.state] }
  return { text: `${unresolvedRounds} ${unresolvedRounds === 1 ? "round" : "rounds"} with the reviewer`, className: "text-muted-foreground" }
}

/**
 * The coordinator's permit chase list on the Starts desk: applications whose
 * decision is late or coming due, and correction rounds still unresolved, in the
 * desk's community lens. Read-only; every row opens the home's permit.
 */
export async function PermitsBand({ communityId, divisionId }: { communityId?: string; divisionId?: string }) {
  if (!await hasPermission("permit.read")) return null
  const queue = await listPermitQueue({ communityId, divisionId }).then(
    (data) => ({ ok: true as const, data }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "Permits are unavailable" }),
  )
  if (!queue.ok) {
    return <p className="border-b px-4 py-2 text-xs text-destructive" role="alert">Permits could not load: {queue.error}</p>
  }
  const { rows, total, truncated } = queue.data
  const overdue = rows.filter((row) => row.aging.attention === "overdue").length
  if (rows.length === 0) {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span className="microlabel">Permits</span>
        <span>Nothing late or waiting on a response.</span>
      </div>
    )
  }
  return (
    <details className="group border-b" open={overdue > 0}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-2 text-xs transition-colors duration-150 hover:bg-muted/40">
        <span className="microlabel">Permits</span>
        {overdue ? <span className="font-medium text-destructive tabular-nums">{overdue} late</span> : null}
        <span className="text-muted-foreground tabular-nums">{rows.length - overdue} coming due or with the reviewer</span>
        <span className="ml-auto text-muted-foreground group-open:hidden">Show</span>
        <span className="ml-auto hidden text-muted-foreground group-open:inline">Hide</span>
      </summary>
      <div className="max-h-72 overflow-y-auto border-t">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-background">
            <tr className="border-b text-muted-foreground">
              <th className="px-4 py-1.5 text-left font-medium">Home</th>
              <th className="px-3 py-1.5 text-left font-medium">Permit</th>
              <th className="px-3 py-1.5 text-left font-medium">Stage</th>
              <th className="px-3 py-1.5 text-left font-medium">Chase</th>
              <th className="px-3 py-1.5 text-left font-medium">Owner</th>
              <th className="px-4 py-1.5 text-right font-medium">Start week</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const action = chase(row)
              return (
                <tr key={row.id} className="border-b last:border-b-0 hover:bg-muted/40">
                  <td className="px-4 py-1.5">
                    <Link href={row.href} className="font-medium hover:underline">{row.communityName} · {row.lotLabel}</Link>
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">{row.permitTypeLabel}{row.permitNumber ? ` ${row.permitNumber}` : ""} · {row.jurisdictionName}</td>
                  <td className="px-3 py-1.5">{row.stageLabel}</td>
                  <td className={cn("px-3 py-1.5 tabular-nums", action.className)}>{action.text}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{row.ownerName ?? <span className="text-warning">Unassigned</span>}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{formatDay(row.startTargetWeek)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {truncated ? <p className="border-t px-4 py-1.5 text-xs text-muted-foreground">Showing {Math.min(PERMIT_QUEUE_CAP, rows.length)} of {total} applications in flight; narrow the desk by community.</p> : null}
      </div>
    </details>
  )
}

export function PermitsBandSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-2" role="status" aria-label="Loading permits">
      <Skeleton className="h-3 w-14" />
      <Skeleton className="h-3 w-48" />
    </div>
  )
}
