"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { setFollowUpAction } from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "@/components/icons"

interface FollowUpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
  currentFollowUp?: string | null
}

export function FollowUpDialog({ open, onOpenChange, contactId, contactName, currentFollowUp }: FollowUpDialogProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  // Parse the current follow-up into date and time
  const getInitialDate = () => {
    if (currentFollowUp) {
      return currentFollowUp.split("T")[0]
    }
    // Default to tomorrow
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    return tomorrow.toISOString().split("T")[0]
  }

  const getInitialTime = () => {
    if (currentFollowUp) {
      const time = currentFollowUp.split("T")[1]
      if (time) return time.substring(0, 5) // HH:mm
    }
    return "09:00"
  }

  const [date, setDate] = useState(getInitialDate())
  const [time, setTime] = useState(getInitialTime())

  const handleSubmit = () => {
    startTransition(async () => {
      try {
        const datetime = date && time ? `${date}T${time}:00.000Z` : null
        await setFollowUpAction({
          contact_id: contactId,
          next_follow_up_at: datetime,
        })
        router.refresh()
        toast({ title: datetime ? "Follow-up scheduled" : "Follow-up cleared" })
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Failed to set follow-up", description: (error as Error).message })
      }
    })
  }

  const handleClear = () => {
    startTransition(async () => {
      try {
        await setFollowUpAction({
          contact_id: contactId,
          next_follow_up_at: null,
        })
        router.refresh()
        toast({ title: "Follow-up cleared" })
        onOpenChange(false)
      } catch (error) {
        toast({ title: "Failed to clear follow-up", description: (error as Error).message })
      }
    })
  }

  // Quick date buttons
  const setQuickDate = (daysFromNow: number) => {
    const d = new Date()
    d.setDate(d.getDate() + daysFromNow)
    setDate(d.toISOString().split("T")[0])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Set follow-up</DialogTitle>
          <DialogDescription>
            Schedule a reminder to follow up with {contactName}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setQuickDate(0)}>
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickDate(1)}>
              Tomorrow
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickDate(3)}>
              In 3 days
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickDate(7)}>
              In 1 week
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date">Date</Label>
              <Input
                id="date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="time">Time</Label>
              <Input
                id="time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="flex justify-between pt-4">
          <Button variant="ghost" onClick={handleClear} disabled={isPending || !currentFollowUp}>
            Clear
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Set follow-up"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
