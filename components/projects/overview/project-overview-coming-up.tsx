"use client"

import Link from "next/link"
import { format, parseISO, isToday, isTomorrow, differenceInDays } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import {
  CalendarDays,
  CheckCircle,
  Flag,
  DollarSign,
  ArrowRight,
  Sparkles,
  Clock,
} from "@/components/icons"
import type { ComingUpItem } from "@/app/(app)/projects/[id]/overview-actions"
import { cn } from "@/lib/utils"

interface ProjectOverviewComingUpProps {
  items: ComingUpItem[]
  projectId: string
}

const typeConfig: Record<string, {
  icon: React.ReactNode
  label: string
  bgClass: string
  textClass: string
}> = {
  milestone: {
    icon: <Flag className="h-4 w-4" />,
    label: "Milestone",
    bgClass: "bg-chart-3/15",
    textClass: "text-chart-3",
  },
  draw: {
    icon: <DollarSign className="h-4 w-4" />,
    label: "Draw",
    bgClass: "bg-success/10",
    textClass: "text-success",
  },
  task: {
    icon: <CheckCircle className="h-4 w-4" />,
    label: "Task",
    bgClass: "bg-primary/10",
    textClass: "text-primary",
  },
  schedule: {
    icon: <CalendarDays className="h-4 w-4" />,
    label: "Schedule",
    bgClass: "bg-muted",
    textClass: "text-muted-foreground",
  },
}

function getRelativeDay(dateStr: string) {
  const date = parseISO(dateStr)
  const today = new Date()
  const days = differenceInDays(date, today)

  if (isToday(date)) return { label: "Today", isUrgent: true }
  if (isTomorrow(date)) return { label: "Tomorrow", isUrgent: true }
  if (days <= 2) return { label: `In ${days} days`, isUrgent: true }
  if (days <= 7) return { label: format(date, "EEEE"), isUrgent: false }
  return { label: format(date, "MMM d"), isUrgent: false }
}

export function ProjectOverviewComingUp({ items, projectId }: ProjectOverviewComingUpProps) {
  // Count milestones and draws for the header
  const milestoneCount = items.filter(i => i.type === "milestone").length
  const drawCount = items.filter(i => i.type === "draw").length
  const todayCount = items.filter(i => isToday(parseISO(i.date))).length

  if (items.length === 0) {
    return (
      <Card className="h-full flex flex-col py-3">
        {/* Compact Header */}
        <div className="px-3 py-1.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-5 w-5 items-center justify-center rounded bg-muted text-muted-foreground">
              <CalendarDays className="h-3.5 w-3.5" />
            </div>
            <span className="text-sm font-semibold">Coming Up</span>
          </div>
          <span className="text-[10px] text-muted-foreground">Next 7 days</span>
        </div>

        <CardContent className="flex-1 flex items-center justify-center px-3 pb-4 pt-2">
          <div className="text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-success/10 text-success mx-auto mb-2">
              <Sparkles className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium">All clear!</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">No items this week</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="h-full flex flex-col py-3">
      {/* Compact Header */}
      <div className="px-3 py-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10 text-primary">
            <CalendarDays className="h-3.5 w-3.5" />
          </div>
          <span className="text-sm font-semibold">Coming Up</span>
        </div>
        <div className="flex items-center gap-2">
          {todayCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-primary">
              {todayCount} today
            </span>
          )}
          {milestoneCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Flag className="h-2.5 w-2.5" />
              {milestoneCount}
            </span>
          )}
          {drawCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <DollarSign className="h-2.5 w-2.5" />
              {drawCount}
            </span>
          )}
        </div>
      </div>

      {/* Timeline List */}
      <CardContent className="px-3 pb-4 pt-2 flex-1 overflow-y-auto">
        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[19px] top-4 bottom-4 w-px bg-border" />

          <div className="space-y-1">
            {items.map((item, index) => {
              const config = typeConfig[item.type] || typeConfig.schedule
              const relativeDay = getRelativeDay(item.date)
              const isMilestone = item.type === "milestone"

              return (
                <Link
                  key={`${item.type}-${item.id}`}
                  href={item.link}
                  className="group block"
                >
                  <div
                    className={cn(
                      "relative flex items-start gap-3 rounded-lg border p-3 transition-all duration-200 ml-1",
                      "hover:shadow-sm hover:-translate-y-0.5",
                      isMilestone && "border-chart-3/30 bg-chart-3/5 hover:border-chart-3/50",
                      !isMilestone && "border-border bg-card hover:border-muted-foreground/30"
                    )}
                  >
                    {/* Timeline Dot */}
                    <div
                      className={cn(
                        "relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                        config.bgClass,
                        config.textClass
                      )}
                    >
                      {config.icon}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium leading-tight truncate pr-2">
                          {item.title}
                        </p>
                        {isMilestone && (
                          <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-chart-3/20 text-chart-3 shrink-0">
                            Milestone
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span
                          className={cn(
                            "text-[10px] font-medium",
                            relativeDay.isUrgent ? "text-primary" : "text-muted-foreground"
                          )}
                        >
                          {relativeDay.label}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {format(parseISO(item.date), "MMM d")}
                        </span>
                        {!isMilestone && (
                          <span className="text-[10px] text-muted-foreground uppercase">
                            {config.label}
                          </span>
                        )}
                      </div>
                      {/* Progress bar for schedule items */}
                      {item.type === "schedule" && typeof item.progress === "number" && item.progress > 0 && (
                        <div className="mt-2 flex items-center gap-2">
                          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full transition-all duration-500"
                              style={{ width: `${item.progress}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground">{item.progress}%</span>
                        </div>
                      )}
                    </div>

                    {/* Arrow */}
                    <ArrowRight className="h-4 w-4 text-muted-foreground/0 transition-all group-hover:text-muted-foreground/50 shrink-0 mt-2" />
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
