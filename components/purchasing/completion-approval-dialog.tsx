"use client"

import { useEffect, useState } from "react"

import { listCompletionInspectionsAction } from "@/app/(app)/purchasing/vpo-actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

type Inspection = { id: string; title: string; inspectedAt: string | null }

const WAIVE = "waive"

/**
 * Approving a completion in an org that requires a passed inspection: pick the
 * inspection that backs it, or waive the requirement with a reason that stays on
 * the completion and in the audit trail.
 */
export function CompletionApprovalDialog({ completionId, open, pending, onOpenChange, onApprove }: {
  completionId: string
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onApprove: (evidence: { inspectionId: string | null; inspectionWaiverReason: string | null }) => void
}) {
  const [inspections, setInspections] = useState<Inspection[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [choice, setChoice] = useState("")
  const [reason, setReason] = useState("")

  useEffect(() => {
    if (!open) return
    setInspections(null)
    setError(null)
    setChoice("")
    setReason("")
    listCompletionInspectionsAction(completionId).then((result) => {
      if (result.success) setInspections(result.data)
      else setError(result.error)
    }).catch(() => setError("Unable to load inspections."))
  }, [open, completionId])

  const waiving = choice === WAIVE
  const ready = waiving ? reason.trim().length >= 5 : choice !== ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Approve completion</DialogTitle>
          <DialogDescription>This organization requires a passed inspection before a completion is paid.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Inspection</Label>
            <Select value={choice} onValueChange={setChoice} disabled={inspections === null && error === null}>
              <SelectTrigger><SelectValue placeholder={inspections === null && error === null ? "Loading inspections…" : "Choose the inspection that passed"} /></SelectTrigger>
              <SelectContent>
                {(inspections ?? []).map((inspection) => (
                  <SelectItem key={inspection.id} value={inspection.id}>
                    {inspection.title}{inspection.inspectedAt ? ` · ${new Date(inspection.inspectedAt).toLocaleDateString("en-US")}` : ""}
                  </SelectItem>
                ))}
                <SelectItem value={WAIVE}>No inspection applies — waive with a reason</SelectItem>
              </SelectContent>
            </Select>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {inspections?.length === 0 && <p className="text-xs text-muted-foreground">No completed, passed inspection is recorded on this home.</p>}
          </div>
          {waiving && (
            <div className="space-y-1.5">
              <Label htmlFor="inspection-waiver">Waiver reason</Label>
              <Textarea id="inspection-waiver" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why this work needs no inspection" />
              <p className="text-xs text-muted-foreground">Recorded on the completion with your name and the time.</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button disabled={!ready || pending} onClick={() => onApprove(waiving
            ? { inspectionId: null, inspectionWaiverReason: reason.trim() }
            : { inspectionId: choice, inspectionWaiverReason: null })}>
            {pending ? "Approving…" : "Approve & bill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
