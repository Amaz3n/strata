"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { toast } from "sonner"

import {
  bookAppointmentAction,
  listOpenSlotsAction,
  rescheduleAppointmentAction,
  searchBookableHomesAction,
} from "@/app/(app)/design-studio/actions"
import { unwrapAction } from "@/lib/action-result"
import type { OpenSlot } from "@/lib/selections/appointment-slots"
import type { AppointmentDto, StudioLocationDto } from "@/lib/services/design-studio-appointments"
import { formatWarrantyVisitClock, warrantyLocalDate } from "@/lib/services/warranty/visit-time"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  communityId?: string
  studios: StudioLocationDto[]
  /** The session being moved; booking a new one when absent. */
  moving?: AppointmentDto | null
  onSaved: () => void
}

type BookableHome = { projectId: string; label: string; communityId: string | null }

const DURATIONS = [60, 90, 120, 180, 240]

/**
 * Books a session, or moves one. The coordinator picks a studio, a consultant
 * who works there and a day; the times offered are the consultant's open hours
 * at that studio with a room free, read in the studio's own zone, and none past
 * a covered cutoff. The database re-checks all of it when the session is saved.
 */
export function BookAppointmentDialog({ open, onOpenChange, communityId, studios, moving, onSaved }: Props) {
  const [pending, startTransition] = useTransition()
  const [projectId, setProjectId] = useState(moving?.projectId ?? "")
  const [homes, setHomes] = useState<BookableHome[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [homesError, setHomesError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [locationId, setLocationId] = useState(moving?.locationId ?? studios[0]?.id ?? "")
  const studio = studios.find((candidate) => candidate.id === locationId) ?? null
  const [consultantUserId, setConsultantUserId] = useState(moving?.consultantUserId ?? studio?.consultants[0]?.userId ?? "")
  const [date, setDate] = useState(() => {
    const zone = moving?.timeZone ?? studio?.timeZone
    return zone ? warrantyLocalDate(moving?.scheduledAt ?? new Date().toISOString(), zone) : ""
  })
  const [duration, setDuration] = useState(moving?.durationMinutes ?? 120)
  const [slots, setSlots] = useState<OpenSlot[] | null>(null)
  const [slotsError, setSlotsError] = useState<string | null>(null)
  const [start, setStart] = useState<string | null>(null)

  const consultants = studio?.consultants ?? []

  useEffect(() => {
    if (!open || moving) return
    let cancelled = false
    const timer = setTimeout(() => {
      searchBookableHomesAction({ communityId, search: search.trim() || undefined })
        .then((result) => {
          if (cancelled) return
          const page = unwrapAction(result)
          setHomes(page.homes)
          setTruncated(page.truncated)
          setHomesError(null)
        })
        .catch((error: unknown) => {
          if (!cancelled) setHomesError(error instanceof Error ? error.message : "Could not load homes")
        })
    }, search ? 250 : 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [open, moving, communityId, search])

  const slotQuery = useMemo(
    () => (open && projectId && locationId && consultantUserId && date ? { locationId, consultantUserId, date, durationMinutes: duration, projectId, appointmentId: moving?.id } : null),
    [open, projectId, locationId, consultantUserId, date, duration, moving?.id],
  )

  useEffect(() => {
    if (!slotQuery) return
    let cancelled = false
    listOpenSlotsAction(slotQuery)
      .then((result) => {
        if (cancelled) return
        setSlots(unwrapAction(result).slots)
        setSlotsError(null)
        setStart(null)
      })
      .catch((error: unknown) => {
        if (!cancelled) setSlotsError(error instanceof Error ? error.message : "Could not load open times")
      })
    return () => {
      cancelled = true
    }
  }, [slotQuery])

  function chooseStudio(next: string) {
    const nextStudio = studios.find((candidate) => candidate.id === next)
    setLocationId(next)
    setConsultantUserId(nextStudio?.consultants[0]?.userId ?? "")
    setSlots(null)
    if (nextStudio && !date) setDate(warrantyLocalDate(new Date().toISOString(), nextStudio.timeZone))
  }

  function save(formData: FormData) {
    if (!start) {
      toast.error("Choose a time")
      return
    }
    startTransition(async () => {
      try {
        if (moving) {
          const saved = unwrapAction(await rescheduleAppointmentAction({ appointmentId: moving.id, locationId, consultantUserId, scheduledAt: start, durationMinutes: duration }))
          if (saved.buyerHasEmail) toast.success("Session moved", { description: "The buyer has been told the new time." })
          else toast.warning("Session moved", { description: "The buyer has no email on file. Tell them the new time yourself." })
        } else {
          const saved = unwrapAction(await bookAppointmentAction({ projectId, locationId, consultantUserId, scheduledAt: start, durationMinutes: duration, notes: String(formData.get("notes") ?? "") || null }))
          if (saved.buyerHasEmail) toast.success("Session booked", { description: "The buyer has been sent the details." })
          else toast.warning("Session booked", { description: "The buyer has no email on file. Tell them the time yourself." })
        }
        onOpenChange(false)
        onSaved()
      } catch (error) {
        toast.error(moving ? "Could not move the session" : "Could not book the session", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-none sm:max-w-lg">
        <form action={save}>
          <DialogHeader>
            <DialogTitle>{moving ? "Move the session" : "Book a selections session"}</DialogTitle>
            <DialogDescription>
              {moving
                ? `${moving.buyerName ?? moving.projectName ?? "The buyer"} hears about the new time. Selection deadlines do not move.`
                : "Times shown are the consultant's open hours at the studio, in the studio's time zone."}
            </DialogDescription>
          </DialogHeader>

          {studios.length === 0 ? (
            <div className="space-y-2 py-6 text-sm">
              <p className="font-medium">No design studio is set up yet</p>
              <p className="text-muted-foreground">Add a studio, its rooms and your consultants&apos; hours before booking.</p>
              <Button asChild size="sm" variant="outline" className="mt-1 h-8 rounded-none">
                <Link href="/design-studio/studios">Set up studios</Link>
              </Button>
            </div>
          ) : (
            <div className="space-y-3 py-4">
              {!moving && (
                <div className="space-y-1.5">
                  <Label htmlFor="appointment-home">Home</Label>
                  <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by lot number" aria-label="Search homes by lot number" className="rounded-none" />
                  {homesError ? (
                    <p role="alert" className="text-sm text-destructive">{homesError}</p>
                  ) : homes === null ? (
                    <Skeleton className="h-9 w-full rounded-none" />
                  ) : homes.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {search.trim() ? "No home with that lot number is waiting on selections." : "No home is waiting on selections right now."}
                    </p>
                  ) : (
                    <Select value={projectId} onValueChange={setProjectId}>
                      <SelectTrigger id="appointment-home" className="rounded-none"><SelectValue placeholder="Choose a home" /></SelectTrigger>
                      <SelectContent>
                        {homes.map((home) => <SelectItem key={home.projectId} value={home.projectId}>{home.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  )}
                  {truncated && homes ? <p className="text-xs text-warning">Showing the first {homes.length} homes. Search by lot number to find others.</p> : null}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="appointment-studio">Studio</Label>
                  <Select value={locationId} onValueChange={chooseStudio}>
                    <SelectTrigger id="appointment-studio" className="rounded-none"><SelectValue placeholder="Choose a studio" /></SelectTrigger>
                    <SelectContent>
                      {studios.map((candidate) => <SelectItem key={candidate.id} value={candidate.id}>{candidate.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="appointment-consultant">Consultant</Label>
                  <Select value={consultantUserId} onValueChange={setConsultantUserId} disabled={consultants.length === 0}>
                    <SelectTrigger id="appointment-consultant" className="rounded-none">
                      <SelectValue placeholder={consultants.length === 0 ? "No one has hours here" : "Choose a consultant"} />
                    </SelectTrigger>
                    <SelectContent>
                      {consultants.map((consultant) => <SelectItem key={consultant.userId} value={consultant.userId}>{consultant.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="appointment-date">Day</Label>
                  <Input id="appointment-date" type="date" value={date} onChange={(event) => setDate(event.target.value)} required className="rounded-none" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="appointment-duration">Length</Label>
                  <Select value={String(duration)} onValueChange={(value) => setDuration(Number(value))}>
                    <SelectTrigger id="appointment-duration" className="rounded-none"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {DURATIONS.map((minutes) => <SelectItem key={minutes} value={String(minutes)}>{minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-sm font-medium">Time{studio ? <span className="font-normal text-muted-foreground"> · {studio.timeZone.replace("_", " ")}</span> : null}</p>
                {!slotQuery ? (
                  <p className="text-sm text-muted-foreground">Choose {moving ? "a studio, consultant and day" : "a home, studio, consultant and day"} to see open times.</p>
                ) : slotsError ? (
                  <p role="alert" className="text-sm text-destructive">{slotsError}</p>
                ) : slots === null ? (
                  <div className="grid grid-cols-4 gap-1.5">{Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-8 rounded-none" />)}</div>
                ) : slots.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open times that day: the consultant is off or booked, every room is taken, or the day is past a selection cutoff.</p>
                ) : (
                  <div className="grid max-h-40 grid-cols-4 gap-1.5 overflow-y-auto" role="listbox" aria-label="Open times">
                    {slots.map((slot) => (
                      <button
                        key={slot.start}
                        type="button"
                        role="option"
                        aria-selected={start === slot.start}
                        onClick={() => setStart(slot.start)}
                        className={`h-8 border text-[12.5px] tabular-nums transition-colors ${start === slot.start ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                      >
                        {studio ? formatWarrantyVisitClock(slot.start, studio.timeZone) : slot.start}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {!moving && (
                <div className="space-y-1.5">
                  <Label htmlFor="appointment-notes">Notes</Label>
                  <Textarea id="appointment-notes" name="notes" maxLength={2000} placeholder="What the buyer is coming in for" className="rounded-none" />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="submit" disabled={pending || !start || studios.length === 0} className="rounded-none">
              {moving ? "Move session" : "Book session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
