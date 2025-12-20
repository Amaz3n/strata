"use client"

import { format, addDays, isWithinInterval, parseISO, differenceInDays } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { PortalFinancialSummaryCard } from "@/components/portal/portal-financial-summary"
import type { ClientPortalData } from "@/lib/types"

interface PortalHomeTabProps {
  data: ClientPortalData
}

function calculateProjectProgress(data: ClientPortalData): { percent: number; label: string } {
  // Method 1: Use schedule items progress if available
  const scheduleItems = data.schedule ?? []
  if (scheduleItems.length > 0) {
    const totalProgress = scheduleItems.reduce((sum, item) => sum + (item.progress ?? 0), 0)
    const avgProgress = Math.round(totalProgress / scheduleItems.length)
    return { percent: avgProgress, label: "based on schedule" }
  }

  // Method 2: Use time-based progress if we have dates
  if (data.project.start_date && data.project.end_date) {
    const start = parseISO(data.project.start_date)
    const end = parseISO(data.project.end_date)
    const today = new Date()
    const totalDays = differenceInDays(end, start)
    const elapsedDays = differenceInDays(today, start)

    if (totalDays > 0) {
      const percent = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)))
      return { percent, label: "based on timeline" }
    }
  }

  return { percent: 0, label: "" }
}

function getTwoWeekLookahead(data: ClientPortalData) {
  const today = new Date()
  const twoWeeksOut = addDays(today, 14)

  return (data.schedule ?? []).filter((item) => {
    if (!item.start_date) return false
    const startDate = parseISO(item.start_date)
    return isWithinInterval(startDate, { start: today, end: twoWeeksOut }) ||
      (item.status === "in_progress")
  }).slice(0, 5)
}

export function PortalHomeTab({ data }: PortalHomeTabProps) {
  const pendingCount = data.pendingChangeOrders.length + data.pendingSelections.length
  const progress = calculateProjectProgress(data)
  const lookahead = getTwoWeekLookahead(data)

  return (
    <div className="space-y-4">
      {/* Progress Gauge */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Project Progress</span>
            <span className="text-2xl font-semibold">{progress.percent}%</span>
          </div>
          <Progress value={progress.percent} className="h-3" />
          {progress.label && (
            <p className="text-xs text-muted-foreground text-right">{progress.label}</p>
          )}
          {data.project.start_date && data.project.end_date && (
            <div className="flex justify-between text-xs text-muted-foreground pt-1">
              <span>Started {format(parseISO(data.project.start_date), "MMM d, yyyy")}</span>
              <span>Target {format(parseISO(data.project.end_date), "MMM d, yyyy")}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {data.financialSummary && (
        <PortalFinancialSummaryCard summary={data.financialSummary} />
      )}

      {pendingCount > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Items needing your attention</span>
              <Badge variant="destructive">{pendingCount}</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2-Week Look-ahead */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">2-Week Look-ahead</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {lookahead.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scheduled work in the next 2 weeks</p>
          ) : (
            lookahead.map((item) => (
              <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  {item.start_date && (
                    <p className="text-xs text-muted-foreground">
                      {format(parseISO(item.start_date), "EEE, MMM d")}
                      {item.end_date && item.end_date !== item.start_date && (
                        <> - {format(parseISO(item.end_date), "MMM d")}</>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-2">
                  {typeof item.progress === "number" && item.progress > 0 && (
                    <span className="text-xs text-muted-foreground">{item.progress}%</span>
                  )}
                  <Badge
                    variant={item.status === "in_progress" ? "default" : "secondary"}
                    className="capitalize text-xs"
                  >
                    {item.status.replaceAll("_", " ")}
                  </Badge>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  )
}
