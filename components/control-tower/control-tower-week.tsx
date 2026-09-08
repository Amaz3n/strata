import Link from "next/link"

import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  Flag,
  Hammer,
  Truck,
} from "@/components/icons"
import { humanize, type RollupLookaheadItem, type WeekAhead } from "@/lib/control-tower/model"
import { cn } from "@/lib/utils"

/** Rows past this in one day stop being a plan and start being a wall. */
const ITEMS_PER_DAY = 4

const ITEM_ICON: Record<string, React.ReactNode> = {
  inspection: <CheckSquare className="h-3.5 w-3.5" />,
  milestone: <Flag className="h-3.5 w-3.5" />,
  delivery: <Truck className="h-3.5 w-3.5" />,
  task: <Hammer className="h-3.5 w-3.5" />,
}

function kindLabel(item: RollupLookaheadItem): string {
  if (item.kind === "task_due") return "Task due"
  if (item.kind === "schedule_finish") return "Finishes"
  return "Starts"
}

/**
 * The next seven days of field work, and where it collides.
 *
 * Collisions lead each day because they are the only thing here a builder can
 * still fix: the same trade booked on three jobs on Thursday, or one
 * superintendent expected in two places, is a problem that costs nothing to
 * solve today and a day of float to solve on the day.
 */
export function ControlTowerWeek({ week }: { week: WeekAhead }) {
  const active = week.days.filter((day) => day.items.length > 0 || day.collisions.length > 0)

  return (
    <section>
      <header className="flex min-h-[2.75rem] items-center justify-between gap-3 border-b px-5 py-2.5">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
            This week
          </h2>
          {week.totalItems > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
              {week.totalItems} starting, finishing or due
            </span>
          )}
        </div>
        {week.collisionCount > 0 && (
          <span className="inline-flex items-center gap-1.5 bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-warning">
            <span className="h-1 w-1 rounded-full bg-warning" />
            {week.collisionCount} collision{week.collisionCount === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {active.length === 0 ? (
        <div className="flex flex-col items-center justify-center px-5 py-16 text-center">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <p className="mt-3 text-sm font-medium text-foreground">A clear week</p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            Nothing starts, finishes, or comes due in the next seven days, and no trade or
            supervisor is booked across two jobs on the same day.
          </p>
        </div>
      ) : (
        <div>
          {active.map((day) => {
            const shown = day.items.slice(0, ITEMS_PER_DAY)
            const hidden = day.items.length - shown.length
            return (
              <div key={day.key} className="border-b last:border-b-0">
                <div className="flex items-baseline justify-between gap-3 px-5 pb-1 pt-3">
                  <h3
                    className={cn(
                      "text-[11px] font-semibold uppercase tracking-[0.12em]",
                      day.isToday ? "text-foreground" : "text-foreground/70",
                    )}
                  >
                    {day.label}
                  </h3>
                  {day.activeItems > 0 && (
                    <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
                      {day.activeItems} active on {day.projectCount} job
                      {day.projectCount === 1 ? "" : "s"}
                    </span>
                  )}
                </div>

                {day.collisions.map((collision) => (
                  <div
                    key={collision.id}
                    className={cn(
                      "flex items-center gap-3 px-5 py-2",
                      collision.tone === "destructive" ? "bg-destructive/[0.04]" : "bg-warning/[0.04]",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-7 w-7 shrink-0 items-center justify-center",
                        collision.tone === "destructive"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-warning/12 text-warning",
                      )}
                    >
                      <AlertTriangle className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {collision.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {collision.detail}
                      </span>
                    </span>
                  </div>
                ))}

                {shown.map((item) => (
                  <Link
                    key={item.id}
                    href={
                      item.project_id
                        ? item.kind === "task_due"
                          ? `/projects/${item.project_id}/tasks`
                          : `/projects/${item.project_id}/schedule`
                        : "/schedule"
                    }
                    className="group flex items-center gap-3 px-5 py-2 transition-colors hover:bg-foreground/[0.03]"
                  >
                    <span
                      className={cn(
                        "inline-flex h-7 w-7 shrink-0 items-center justify-center",
                        item.is_critical_path
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {ITEM_ICON[item.item_type ?? ""] ?? <CalendarDays className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {item.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {[kindLabel(item), humanize(item.trade), item.project_name]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    {item.is_critical_path && (
                      <span className="hidden shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-destructive sm:inline">
                        Critical
                      </span>
                    )}
                  </Link>
                ))}

                {hidden > 0 && (
                  <p className="px-5 pb-2 pt-0.5 text-[11px] text-muted-foreground">
                    +{hidden} more this day
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
