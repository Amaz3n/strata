import { format, parseISO, isToday, isTomorrow, differenceInCalendarDays } from "date-fns"
import {
  CalendarDays,
  CheckSquare,
  Flag,
  DollarSign,
  Sparkles,
} from "@/components/icons"
import {
  BandBody,
  BandHeader,
  GroupHeader,
  IconChip,
  OverviewEmptyState,
  OverviewRow,
} from "@/components/overview/primitives"
import { cn } from "@/lib/utils"
import type { ComingUpItem } from "@/app/(app)/projects/[id]/overview-actions"

interface ProjectOverviewWeekProps {
  items: ComingUpItem[]
  projectId: string
}

interface DayGroup {
  date: string
  primary: string
  secondary: string
  isToday: boolean
  isTomorrow: boolean
  items: ComingUpItem[]
}

function groupByDay(items: ComingUpItem[]): DayGroup[] {
  const map = new Map<string, ComingUpItem[]>()
  for (const item of items) {
    if (!map.has(item.date)) map.set(item.date, [])
    map.get(item.date)!.push(item)
  }

  const sorted = Array.from(map.entries()).sort(
    ([a], [b]) => new Date(a).getTime() - new Date(b).getTime()
  )

  return sorted.map(([dateStr, dayItems]) => {
    const date = parseISO(dateStr)
    const today = isToday(date)
    const tomorrow = isTomorrow(date)
    const days = differenceInCalendarDays(date, new Date())
    return {
      date: dateStr,
      primary: today
        ? "Today"
        : tomorrow
        ? "Tomorrow"
        : days <= 7 && days >= 0
        ? format(date, "EEEE")
        : format(date, "MMM d"),
      secondary: format(date, "MMM d"),
      isToday: today,
      isTomorrow: tomorrow,
      items: dayItems,
    }
  })
}

export function ProjectOverviewWeek({ items, projectId: _ }: ProjectOverviewWeekProps) {
  const visible = items.slice(0, 12)
  const groups = groupByDay(visible)
  const milestoneCount = visible.filter((i) => i.type === "milestone").length
  const drawCount = visible.filter((i) => i.type === "draw").length

  return (
    <section>
      <BandHeader title="This week" count={visible.length > 0 ? `${visible.length} ahead` : null}>
        {milestoneCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground bg-foreground/[0.07] px-2 py-0.5 rounded-sm">
            <Flag className="h-2.5 w-2.5" strokeWidth={2.5} />
            {milestoneCount}
          </span>
        )}
        {drawCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-success bg-success/10 px-2 py-0.5 rounded-sm">
            <DollarSign className="h-2.5 w-2.5" />
            {drawCount}
          </span>
        )}
      </BandHeader>

      <BandBody>
        {groups.length === 0 ? (
          <OverviewEmptyState
            icon={<Sparkles className="h-5 w-5 text-muted-foreground/70" />}
            tone="neutral"
            title="A clear week"
            description="Nothing scheduled in the next seven days."
          />
        ) : (
          <div className="space-y-7">
            {groups.map((group) => (
              <div key={group.date}>
                <DayHeader group={group} />
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const isMilestone = item.type === "milestone"
                    const isDraw = item.type === "draw"
                    const Icon = isMilestone
                      ? Flag
                      : isDraw
                      ? DollarSign
                      : item.type === "task"
                      ? CheckSquare
                      : CalendarDays
                    const hasProgress =
                      !isMilestone && !isDraw && (item.progress ?? 0) > 0
                    const chipTone: "inverted" | "success" | "neutral" =
                      isMilestone ? "inverted" : isDraw ? "success" : "neutral"
                    return (
                      <li key={`${item.type}-${item.id}`}>
                        <OverviewRow
                          href={item.link}
                          tone={isMilestone ? "emphasis" : isDraw ? "success" : "neutral"}
                        >
                          <IconChip tone={chipTone}>
                            <Icon
                              className="h-3.5 w-3.5"
                              strokeWidth={isMilestone ? 2.5 : 2}
                            />
                          </IconChip>
                          <span
                            className={cn(
                              "flex-1 min-w-0 text-sm truncate",
                              isMilestone
                                ? "font-semibold text-foreground"
                                : "font-medium text-foreground"
                            )}
                          >
                            {item.title}
                          </span>
                          {hasProgress && (
                            <div className="shrink-0 hidden sm:flex items-center gap-2">
                              <div className="h-1 w-14 rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full bg-foreground/70 rounded-full transition-all duration-500"
                                  style={{
                                    width: `${Math.min(100, item.progress!)}%`,
                                  }}
                                />
                              </div>
                              <span className="text-[10px] font-medium tabular-nums text-muted-foreground w-7 text-right">
                                {item.progress}%
                              </span>
                            </div>
                          )}
                          {isMilestone && (
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-foreground/75">
                              Milestone
                            </span>
                          )}
                          {isDraw && (
                            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-success">
                              Draw
                            </span>
                          )}
                        </OverviewRow>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </BandBody>
    </section>
  )
}

function DayHeader({ group }: { group: DayGroup }) {
  return (
    <GroupHeader
      label={group.primary}
      count={group.items.length}
      ruleClassName={
        group.isToday
          ? "bg-foreground/40"
          : group.isTomorrow
          ? "bg-foreground/25"
          : "bg-muted-foreground/30"
      }
      labelClassName={
        group.isToday
          ? "text-foreground"
          : group.isTomorrow
          ? "text-foreground/85"
          : "text-muted-foreground/85"
      }
    >
      <span className="text-[10px] tabular-nums text-muted-foreground/55">{group.secondary}</span>
      {group.isToday && <span aria-hidden className="h-1 w-1 rounded-full bg-foreground" />}
    </GroupHeader>
  )
}
