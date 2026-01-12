"use client"

import { format, addDays, isWithinInterval, parseISO, differenceInDays, isAfter, isBefore } from "date-fns"
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

function getNextMilestoneOrInspection(data: ClientPortalData) {
  const today = new Date()
  const candidates = (data.schedule ?? [])
    .filter((item) => (item.item_type === "inspection" || item.item_type === "milestone") && item.status !== "completed" && item.status !== "cancelled")
    .map((item) => ({
      item,
      date: item.start_date ? parseISO(item.start_date) : undefined,
    }))

  const future = candidates
    .filter((c) => c.date && isAfter(c.date, today))
    .sort((a, b) => (a.date!.getTime() - b.date!.getTime()))

  if (future.length > 0) return future[0]!.item

  const inProgress = candidates.find((c) => c.item.status === "in_progress")
  return inProgress?.item
}

function getNextInvoice(data: ClientPortalData) {
  const today = new Date()
  const openInvoices = (data.invoices ?? []).filter((inv) => {
    const due = inv.balance_due_cents ?? inv.total_cents ?? 0
    if (due <= 0) return false
    return inv.status !== "paid"
  })

  const withDueDates = openInvoices
    .map((inv) => ({ inv, due: inv.due_date ? new Date(inv.due_date) : undefined }))
    .filter((row) => row.due && !Number.isNaN(row.due.getTime()))

  const upcoming = withDueDates
    .filter((row) => isAfter(row.due!, today) || row.due!.toDateString() === today.toDateString())
    .sort((a, b) => a.due!.getTime() - b.due!.getTime())

  if (upcoming.length > 0) return upcoming[0]!.inv

  const pastDue = withDueDates
    .filter((row) => isBefore(row.due!, today))
    .sort((a, b) => a.due!.getTime() - b.due!.getTime())

  if (pastDue.length > 0) return pastDue[0]!.inv
  return openInvoices[0]
}

export function PortalHomeTab({ data }: PortalHomeTabProps) {
  const pendingCount = data.pendingChangeOrders.length + data.pendingSelections.length
  const progress = calculateProjectProgress(data)
  const lookahead = getTwoWeekLookahead(data)
  const nextMilestone = getNextMilestoneOrInspection(data)
  const nextInvoice = getNextInvoice(data)
  const latestPhotoWeek = data.photos?.[0]
  const latestPhotos = latestPhotoWeek?.photos?.slice(0, 3) ?? []

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

      {(nextMilestone || nextInvoice) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Next up</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {nextMilestone && (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{nextMilestone.name}</p>
                  {nextMilestone.start_date && (
                    <p className="text-xs text-muted-foreground">
                      {nextMilestone.item_type === "inspection" ? "Inspection" : "Milestone"} · {format(parseISO(nextMilestone.start_date), "EEE, MMM d")}
                    </p>
                  )}
                </div>
                <Badge variant="outline" className="capitalize text-xs shrink-0">
                  {nextMilestone.status.replaceAll("_", " ")}
                </Badge>
              </div>
            )}
            {nextInvoice && (
              <div className="flex items-start justify-between gap-3 border-t pt-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{nextInvoice.title || nextInvoice.invoice_number}</p>
                  {nextInvoice.due_date && (
                    <p className="text-xs text-muted-foreground">
                      Due {format(new Date(nextInvoice.due_date), "MMM d, yyyy")}
                    </p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <Badge variant="outline" className="capitalize text-xs mb-1">
                    {nextInvoice.status}
                  </Badge>
                  {(nextInvoice.balance_due_cents ?? nextInvoice.total_cents) != null && (
                    <p className="text-sm font-semibold">
                      ${(((nextInvoice.balance_due_cents ?? nextInvoice.total_cents) ?? 0) / 100).toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
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

      {(data.recentLogs.length > 0 || latestPhotos.length > 0) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Recent updates</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {latestPhotos.length > 0 && (
              <div className="space-y-2">
                {latestPhotoWeek?.week_start && latestPhotoWeek?.week_end && (
                  <p className="text-xs text-muted-foreground">
                    Photos · Week of {format(new Date(latestPhotoWeek.week_start), "MMM d")} – {format(new Date(latestPhotoWeek.week_end), "MMM d")}
                  </p>
                )}
                <div className="grid grid-cols-3 gap-2">
                  {latestPhotos.map((photo) => (
                    <div key={photo.id} className="aspect-square rounded-md overflow-hidden bg-muted">
                      <img src={photo.url} alt="" className="h-full w-full object-cover" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {data.recentLogs.length > 0 && (
              <div className={latestPhotos.length > 0 ? "border-t pt-3" : ""}>
                <p className="text-xs text-muted-foreground mb-2">Recent logs</p>
                <div className="space-y-2">
                  {data.recentLogs.slice(0, 3).map((log) => (
                    <div key={log.id} className="text-sm">
                      <p className="font-medium">
                        {format(parseISO(log.date), "MMM d, yyyy")}
                      </p>
                      {log.notes && <p className="text-xs text-muted-foreground line-clamp-2">{log.notes}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
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
