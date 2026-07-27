"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"

import { upsertAppointmentAction } from "@/app/(app)/design-studio/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Homes under contract with an open selection group — not every project. */
  homes: Array<{ projectId: string; label: string; communityId: string | null }>
  communityId?: string
  onBooked: () => void
}

export function BookAppointmentDialog({ open, onOpenChange, homes, communityId, onBooked }: Props) {
  const [projectId, setProjectId] = useState("")
  const [pending, startTransition] = useTransition()

  function book(formData: FormData) {
    if (!projectId) {
      toast.error("Choose a home")
      return
    }
    const scheduledAt = String(formData.get("scheduledAt") ?? "")
    const localDate = new Date(scheduledAt)
    if (Number.isNaN(localDate.getTime())) {
      toast.error("Choose a date and time")
      return
    }
    const home = homes.find((candidate) => candidate.projectId === projectId)
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertAppointmentAction({
            communityId: home?.communityId ?? communityId ?? null,
            projectId,
            scheduledAt: localDate.toISOString(),
            durationMinutes: Number(formData.get("durationMinutes") ?? 120),
            location: String(formData.get("location") ?? "") || null,
            status: "scheduled",
            groupIds: [],
          }),
        )
        onOpenChange(false)
        setProjectId("")
        toast.success("Appointment booked")
        onBooked()
      } catch (error) {
        toast.error("Could not book the appointment", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none">
        <form action={book}>
          <DialogHeader>
            <DialogTitle>Book a selections appointment</DialogTitle>
            <DialogDescription>
              Homes under contract with at least one open selection group.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="appointment-home">Home</Label>
              {homes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No home is waiting on selections right now.
                </p>
              ) : (
                <Select value={projectId} onValueChange={setProjectId}>
                  <SelectTrigger id="appointment-home" className="rounded-none">
                    <SelectValue placeholder="Choose a home" />
                  </SelectTrigger>
                  <SelectContent>
                    {homes.map((home) => (
                      <SelectItem key={home.projectId} value={home.projectId}>
                        {home.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="appointment-time">Date and time</Label>
              <Input id="appointment-time" name="scheduledAt" type="datetime-local" required className="rounded-none" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="appointment-duration">Duration (minutes)</Label>
                <Input
                  id="appointment-duration"
                  name="durationMinutes"
                  type="number"
                  min="15"
                  max="1440"
                  step="15"
                  defaultValue="120"
                  className="rounded-none"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="appointment-location">Location</Label>
                <Input id="appointment-location" name="location" placeholder="Design studio" className="rounded-none" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending || homes.length === 0} className="rounded-none">
              Book appointment
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
