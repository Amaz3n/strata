"use client"

import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import type { ScheduleReschedulePreview } from "@/lib/services/schedule"

const VISIBLE_CHANGES = 12
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const formatDay = (date: string | null) => (date ? dayFormat.format(new Date(`${date}T00:00:00Z`)) : "—")
const formatRange = (start: string | null, end: string | null) =>
  (!end || start === end ? formatDay(start) : `${formatDay(start)} – ${formatDay(end)}`)

export interface RescheduleApproval {
  acknowledgeCloseImpacts: string[]
  reason: string | undefined
}

interface Props {
  open: boolean
  title: string
  description: string
  /** Null while the server is working out the plan. */
  preview: ScheduleReschedulePreview | null
  applying: boolean
  applyLabel: string
  onCancel: () => void
  onApply: (approval: RescheduleApproval) => void
}

/**
 * What a date move will do, worked out by the server: every task it moves
 * (requested and pulled along by dependencies) and every promised close it
 * pushes past its date. A close breach is accepted house by house, with a reason,
 * by someone who may release starts; nothing is written until Apply.
 */
export function RescheduleReviewDialog({ open, title, description, preview, applying, applyLabel, onCancel, onApply }: Props) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !applying) onCancel() }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {preview ? (
          <ReviewBody key={preview.changes.map((change) => change.id).join(",")} preview={preview} applying={applying} applyLabel={applyLabel} onCancel={onCancel} onApply={onApply} />
        ) : (
          <div className="space-y-2" aria-busy role="status" aria-label="Working out the schedule">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ReviewBody({ preview, applying, applyLabel, onCancel, onApply }: Pick<Props, "applying" | "applyLabel" | "onCancel" | "onApply"> & { preview: ScheduleReschedulePreview }) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [reason, setReason] = useState("")
  const impacts = preview.closeImpacts
  const needsApproval = impacts.length > 0
  const trimmed = reason.trim()
  const ready = !needsApproval || (preview.canApproveCloseImpacts && impacts.every((impact) => accepted.has(impact.projectId)) && trimmed.length >= 10)
  const shown = preview.changes.slice(0, VISIBLE_CHANGES)

  return (
    <>
      <div className="max-h-64 overflow-auto border">
        <Table>
          <TableHeader>
            <TableRow><TableHead>Task</TableHead><TableHead>From</TableHead><TableHead>To</TableHead><TableHead>Why</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((change) => (
              <TableRow key={change.id} className="text-xs">
                <TableCell className="font-medium">{change.name}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{formatRange(change.oldStart, change.oldEnd)}</TableCell>
                <TableCell className="tabular-nums">{formatRange(change.newStart, change.newEnd)}</TableCell>
                <TableCell className="text-muted-foreground">{change.cause === "requested" ? "Requested" : "Follows a predecessor"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {preview.changes.length > shown.length ? (
        <p className="text-xs text-muted-foreground">Showing {shown.length} of {preview.changes.length} tasks that move.</p>
      ) : null}

      {needsApproval ? (
        <div className="space-y-3 border border-destructive/40 p-3">
          <p className="text-sm font-medium text-destructive">This pushes a promised close past its date</p>
          {impacts.map((impact) => (
            <div key={impact.projectId} className="flex items-start gap-2">
              <Checkbox
                id={`close-${impact.projectId}`}
                checked={accepted.has(impact.projectId)}
                disabled={!preview.canApproveCloseImpacts}
                onCheckedChange={(checked) => setAccepted((current) => {
                  const next = new Set(current)
                  if (checked === true) next.add(impact.projectId)
                  else next.delete(impact.projectId)
                  return next
                })}
              />
              <Label htmlFor={`close-${impact.projectId}`} className="text-xs font-normal leading-snug">
                <span className="font-medium">{impact.projectName}</span> closes {formatDay(impact.scheduledDate)}; work now finishes{" "}
                {formatDay(impact.projectedFinish)} (<span className="tabular-nums text-destructive">{impact.daysLate} days late</span>). Accept the new risk.
              </Label>
            </div>
          ))}
          {preview.canApproveCloseImpacts ? (
            <div className="grid gap-1.5">
              <Label htmlFor="reschedule-reason">Why the close can slip</Label>
              <Textarea id="reschedule-reason" rows={2} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} />
              <p className="text-xs text-muted-foreground">Recorded with the change. At least 10 characters.</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">A starts coordinator (start.release) has to approve a move that pushes a promised close.</p>
          )}
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="outline" disabled={applying} onClick={onCancel}>Cancel</Button>
        <Button
          disabled={applying || !ready}
          onClick={() => onApply({ acknowledgeCloseImpacts: Array.from(accepted), reason: trimmed || undefined })}
        >
          {applying ? "Applying…" : applyLabel}
        </Button>
      </DialogFooter>
    </>
  )
}
