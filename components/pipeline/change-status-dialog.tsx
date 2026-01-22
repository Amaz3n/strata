"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { changeLeadStatusAction } from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "@/components/icons"
import type { LeadStatus } from "@/lib/validation/crm"

interface ChangeStatusDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
  currentStatus: LeadStatus
}

const statusOptions: { value: LeadStatus; label: string }[] = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "estimating", label: "Estimating" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
]

export function ChangeStatusDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  currentStatus,
}: ChangeStatusDialogProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const [status, setStatus] = useState<LeadStatus>(currentStatus)
  const [lostReason, setLostReason] = useState("")

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        await changeLeadStatusAction({
          contact_id: contactId,
          lead_status: status,
          lead_lost_reason: status === "lost" ? lostReason.trim() || undefined : undefined,
        })
        router.refresh()
        toast({ title: "Status updated" })
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Failed to update status", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Change status</DialogTitle>
          <DialogDescription>
            Update the pipeline status for {contactName}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as LeadStatus)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {status === "lost" && (
            <div className="space-y-2">
              <Label htmlFor="lost_reason">Reason for loss</Label>
              <Textarea
                id="lost_reason"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value)}
                placeholder="Price, timeline, went with competitor, etc."
                rows={3}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || status === currentStatus}>
            {isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Updating...
              </>
            ) : (
              "Update status"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
