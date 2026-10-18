import Link from "next/link"

import { fieldRecordsRows } from "@/lib/field/field-records"
import type { ProductionHomeData } from "@/lib/services/production-home"

type Assigned = NonNullable<ProductionHomeData["assigned"]>

/**
 * The cross-home review: which of the viewer's assigned houses have no daily
 * log today and which carry photos nobody has logged since. Counts cover every
 * house loaded; rows are the worst first, capped with the remainder stated.
 */
export function FieldRecordsBand({ assigned }: { assigned: Assigned }) {
  const today = new Date().toISOString().slice(0, 10)
  const { rows: shown, hidden } = fieldRecordsRows(assigned.houses, today)
  const partial = assigned.houseCount > assigned.houses.length

  return (
    <section className="desk-rise border-t" style={{ "--desk-stagger": 2 } as React.CSSProperties}>
      <div className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
        <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">Field records</h2>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          <span className={assigned.missingLogCount > 0 ? "font-medium text-warning" : undefined}>
            {assigned.missingLogCount} without a log today
          </span>
          {" · "}
          {assigned.newPhotoCount} new photos
        </p>
      </div>
      {shown.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">Every house has today&apos;s log and no unlogged photos.</p>
      ) : (
        <ul>
          {shown.map(({ house, missingLog }) => (
            <li className="flex items-baseline gap-3 border-b px-5 py-2.5 text-[13px]" key={house.projectId}>
              <span className="w-24 shrink-0 truncate font-medium">{house.lotLabel}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{house.communityName}</span>
              <Link
                className={missingLog ? "shrink-0 font-medium text-warning underline-offset-4 hover:underline" : "shrink-0 text-muted-foreground underline-offset-4 hover:underline"}
                href={`/projects/${house.projectId}/daily-logs`}
              >
                {missingLog ? "No log today" : "Log up to date"}
              </Link>
              <Link
                className="w-20 shrink-0 text-right tabular-nums text-muted-foreground underline-offset-4 hover:underline"
                href={`/projects/${house.projectId}/photos`}
              >
                {house.newPhotoCount > 0 ? `${house.newPhotoCount} new` : "No new"}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {(hidden > 0 || partial) && (
        <p className="px-5 py-2 text-[11px] text-muted-foreground">
          {hidden > 0 && `Showing ${shown.length} of ${shown.length + hidden} houses that need review. `}
          {partial && `Counts cover the first ${assigned.houses.length} of ${assigned.houseCount} assigned houses; narrow the division to see the rest.`}
        </p>
      )}
    </section>
  )
}
