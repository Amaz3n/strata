"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { RescheduleReviewDialog, type RescheduleApproval } from "@/components/schedule/reschedule-review"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import type { ScheduleReschedulePreview } from "@/lib/services/schedule"
import type { TradeResponseQueueRow } from "@/lib/services/trade-responses"
import {
  approveTradeRescheduleAction,
  previewTradeRescheduleAction,
  resolveTradeResponseAction,
} from "@/app/(app)/schedule/trade-response-actions"

const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const formatDay = (date: string | null) => (date ? dayFormat.format(new Date(`${date}T00:00:00Z`)) : "—")
const formatRange = (start: string | null, end: string | null) =>
  (!end || start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`)

interface Props {
  rows: TradeResponseQueueRow[]
  canSchedule: boolean
}

export function TradeResponseQueue({ rows, canSchedule }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [review, setReview] = useState<{ row: TradeResponseQueueRow; preview: ScheduleReschedulePreview | null } | null>(null)

  if (!rows.length) return <p className="px-3 py-2 text-xs text-muted-foreground">No trade answers need a decision.</p>

  const resolve = (row: TradeResponseQueueRow, resolution: "acknowledged" | "reschedule_declined") => {
    startTransition(async () => {
      try {
        unwrapAction(await resolveTradeResponseAction({ responseId: row.id, resolution }))
        toast.success(resolution === "acknowledged" ? "Decline acknowledged" : "Request declined")
        router.refresh()
      } catch (error) {
        toast.error("Unable to close this answer", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const openReview = (row: TradeResponseQueueRow) => {
    setReview({ row, preview: null })
    startTransition(async () => {
      try {
        const preview = unwrapAction(await previewTradeRescheduleAction(row.id))
        setReview({ row, preview })
      } catch (error) {
        setReview(null)
        toast.error("Unable to review the new dates", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const apply = (approval: RescheduleApproval) => {
    if (!review) return
    const { row } = review
    startTransition(async () => {
      try {
        unwrapAction(await approveTradeRescheduleAction({ responseId: row.id, ...approval }))
        toast.success(`${row.companyName} moved to ${formatRange(row.proposedStart, row.proposedEnd)}`)
        setReview(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to apply the new dates", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Trade company</TableHead><TableHead>Home</TableHead><TableHead>Task</TableHead>
              <TableHead>Answer</TableHead><TableHead>Scheduled</TableHead><TableHead>Asked for</TableHead><TableHead>Why</TableHead><TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const declined = row.response === "declined"
              return (
                <TableRow key={row.id} className="text-xs">
                  <TableCell className="font-medium">{row.companyName}</TableCell>
                  <TableCell>{row.projectName}</TableCell>
                  <TableCell>
                    <Link className="underline underline-offset-4" href={`/projects/${encodeURIComponent(row.projectId)}/schedule?item=${encodeURIComponent(row.scheduleItemId)}`}>{row.itemName}</Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={cn(declined ? "text-destructive" : "text-warning")}>{declined ? "Declined" : "New dates"}</Badge>
                    {row.stale ? <Badge variant="outline" className="ml-1 text-muted-foreground">Dates moved since</Badge> : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatRange(row.currentStart, row.currentEnd)}</TableCell>
                  <TableCell className="tabular-nums">{declined ? "—" : formatRange(row.proposedStart, row.proposedEnd)}</TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground" title={row.reason ?? undefined}>{row.reason ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex gap-1.5">
                      {declined ? (
                        <>
                          <Link className="inline-flex items-center px-2 text-xs underline underline-offset-4" href={`/projects/${encodeURIComponent(row.projectId)}/schedule?item=${encodeURIComponent(row.scheduleItemId)}`}>Reassign</Link>
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => resolve(row, "acknowledged")}>Acknowledge</Button>
                        </>
                      ) : (
                        <>
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => resolve(row, "reschedule_declined")}>Decline request</Button>
                          <Button size="sm" disabled={pending || row.stale || !canSchedule} title={!canSchedule ? "Moving dates needs schedule.edit" : row.stale ? "The task moved after the trade asked" : undefined} onClick={() => openReview(row)}>Review dates</Button>
                        </>
                      )}
                    </span>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <RescheduleReviewDialog
        open={review !== null}
        title={review ? `Move ${review.row.itemName} for ${review.row.companyName}` : "Review new dates"}
        description="These dates are worked out from the schedule's dependencies. Nothing changes until you apply."
        preview={review?.preview ?? null}
        applying={pending && review?.preview !== null}
        applyLabel="Apply new dates"
        onCancel={() => setReview(null)}
        onApply={apply}
      />
    </>
  )
}
