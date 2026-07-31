"use client"

import Link from "next/link"
import { useTransition } from "react"

import { completeScheduleItemAction } from "@/app/(app)/actions"
import { shortDate } from "@/components/home/short-date"
import { Check } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { unwrapAction } from "@/lib/action-result"
import type { MyHouseTaskGroupDTO } from "@/lib/services/my-houses"
import { cn } from "@/lib/utils"

/** Rows past this in a single activity stop being a list and start being a wall. */
const ITEMS_PER_GROUP = 4

/**
 * "Now" for a superintendent. They work one activity across many lots — six frame
 * inspections, then four drywall starts — not one house at a time, so this groups
 * by activity and clears rows in place. Lateness is flagged on the row rather than
 * split into a second list; the same house appearing under two headings is what
 * made this page unreadable.
 */
export function NowActivities({
  groups,
  truncated,
}: {
  groups: MyHouseTaskGroupDTO[]
  truncated: boolean
}) {
  const [pending, startTransition] = useTransition()

  const complete = (scheduleItemId: string) => {
    startTransition(async () => {
      unwrapAction(await completeScheduleItemAction(scheduleItemId))
    })
  }

  if (!groups.length) {
    return (
      <p className="px-5 py-10 text-center text-sm text-muted-foreground">
        Nothing scheduled in this window. Widen it above to look further ahead.
      </p>
    )
  }

  return (
    <div>
      {groups.map((group) => {
        const shown = group.items.slice(0, ITEMS_PER_GROUP)
        const hidden = group.items.length - shown.length
        return (
          <section key={group.groupKey} className="border-t first:border-t-0">
            <div className="flex items-baseline gap-2 px-5 pb-1 pt-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground/75">
                {group.groupLabel}
              </h3>
              <span className="text-[10px] font-medium tabular-nums text-muted-foreground/70">
                {group.items.length}
              </span>
            </div>
            {shown.map((item) => (
              <div
                key={item.scheduleItemId}
                className="group/row flex items-center gap-3 px-5 py-1.5 transition-colors hover:bg-foreground/[0.03]"
              >
                <Link
                  href={`/projects/${item.projectId}`}
                  className="w-14 shrink-0 truncate text-[13px] font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {item.lotLabel}
                </Link>
                {/* No trade column — the group header already names the activity,
                    and the pane is too narrow to spend width restating it. */}
                <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                  {item.communityName}
                </span>
                <span className="w-12 shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">
                  {shortDate(item.endDate ?? item.startDate)}
                </span>
                <span
                  className={cn(
                    "w-14 shrink-0 text-right text-[12px] font-medium tabular-nums",
                    item.daysLate ? "text-destructive" : "text-transparent",
                  )}
                >
                  {item.daysLate ? `${item.daysLate}d late` : ""}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => complete(item.scheduleItemId)}
                  className="h-6 shrink-0 gap-1 px-1.5 text-[11px] font-medium text-muted-foreground/70 hover:text-foreground"
                >
                  <Check className="h-3 w-3" />
                  Complete
                </Button>
              </div>
            ))}
            {hidden > 0 && (
              <p className="px-5 pb-2 pt-0.5 text-[11px] text-muted-foreground">
                +{hidden} more {hidden === 1 ? "house" : "houses"} on this activity
              </p>
            )}
          </section>
        )
      })}
      {truncated && (
        <p className="border-t px-5 py-2 text-[11px] text-muted-foreground">
          Busiest activities only — open a house for its full schedule.
        </p>
      )}
    </div>
  )
}
