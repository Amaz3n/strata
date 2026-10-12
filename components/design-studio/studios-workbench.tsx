"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { saveConsultantHoursAction, saveStudioLocationAction, saveStudioRoomsAction } from "@/app/(app)/design-studio/actions"
import { unwrapAction } from "@/lib/action-result"
import { WEEKDAY_LABELS, formatMinuteOfDay, type HoursWindow } from "@/lib/selections/appointment-slots"
import type { StudioDirectory, StudioLocationDto } from "@/lib/services/design-studio-appointments"
import { US_TIMEZONES } from "@/components/bids/bid-workbench-helpers"
import { StudioShell } from "@/components/design-studio/studio-shell"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Edit, Plus } from "@/components/icons"

interface Props {
  directory: StudioDirectory
  canManage: boolean
}

type Editing =
  | { kind: "studio"; studio: StudioLocationDto | null }
  | { kind: "rooms"; studio: StudioLocationDto }
  | { kind: "hours"; studio: StudioLocationDto; userId: string | null }

function toClock(minute: number) {
  if (minute >= 1440) return "23:59"
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`
}

function fromClock(value: string, end: boolean) {
  const [hours, minutes] = value.split(":").map(Number)
  const minute = hours * 60 + minutes
  return end && minute === 1439 ? 1440 : minute
}

function windowText(windows: HoursWindow[], weekday: number) {
  const day = windows.filter((window) => window.weekday === weekday)
  if (day.length === 0) return "—"
  return day.map((window) => `${formatMinuteOfDay(window.startMinute)}–${formatMinuteOfDay(window.endMinute)}`).join(", ")
}

/**
 * The studio's setup: where sessions happen, how many can run at once (its
 * rooms in service), and when each consultant works there. Booking reads all
 * three; the database enforces all three.
 */
export function StudiosWorkbench({ directory, canManage }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState<Editing | null>(null)
  const close = () => setEditing(null)
  const saved = () => {
    close()
    router.refresh()
  }

  return (
    <StudioShell
      active="studios"
      action={
        canManage ? (
          <Button size="sm" className="h-8 rounded-none" onClick={() => setEditing({ kind: "studio", studio: null })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add studio
          </Button>
        ) : null
      }
    >
      {directory.locations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No design studio is set up yet</p>
          <p className="max-w-md text-[13px] text-muted-foreground">
            Add the studio buyers come to, its rooms, and when each consultant works there. Sessions are booked only into open hours with a room free.
          </p>
          {canManage && (
            <Button size="sm" variant="outline" className="mt-2 h-8 rounded-none" onClick={() => setEditing({ kind: "studio", studio: null })}>
              Add studio
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col desk-rise">
          {directory.locations.map((studio) => (
            <section key={studio.id} id={studio.id} className="border-b border-border px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-[15px] font-semibold tracking-tight">{studio.name}</h2>
                    {studio.isArchived && <Badge variant="outline" className="rounded-full text-[10px]">Closed</Badge>}
                  </div>
                  <p className="text-[12px] text-muted-foreground">
                    {[studio.address, studio.timeZone.replace("_", " ")].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-1.5">
                    <Button size="sm" variant="ghost" className="h-7 rounded-none" onClick={() => setEditing({ kind: "studio", studio })}>
                      <Edit className="mr-1.5 h-3.5 w-3.5" />
                      Edit studio
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 rounded-none" onClick={() => setEditing({ kind: "rooms", studio })}>Rooms</Button>
                    <Button size="sm" variant="outline" className="h-7 rounded-none" onClick={() => setEditing({ kind: "hours", studio, userId: null })}>Add hours</Button>
                  </div>
                )}
              </div>

              <div className="mt-3 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
                <div>
                  <p className="microlabel mb-1.5">Rooms · {studio.rooms.filter((room) => room.isActive).length} in service</p>
                  {studio.rooms.length === 0 ? (
                    <p className="text-[12.5px] text-muted-foreground">No rooms: nothing can be booked here.</p>
                  ) : (
                    <ul className="flex flex-col">
                      {studio.rooms.map((room) => (
                        <li key={room.id} className="flex items-center justify-between border-b py-1.5 text-[12.5px] last:border-b-0 border-border">
                          <span className={room.isActive ? "" : "text-muted-foreground line-through"}>{room.name}</span>
                          {!room.isActive && <span className="text-[11px] text-muted-foreground">Out of service</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="min-w-0 overflow-x-auto">
                  <p className="microlabel mb-1.5">Consultant hours</p>
                  {studio.consultants.length === 0 ? (
                    <p className="text-[12.5px] text-muted-foreground">No one has hours here yet.</p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Consultant</TableHead>
                          {WEEKDAY_LABELS.map((label) => <TableHead key={label} className="text-[11px]">{label}</TableHead>)}
                          {canManage && <TableHead className="w-16" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {studio.consultants.map((consultant) => (
                          <TableRow key={consultant.userId}>
                            <TableCell className="text-[12.5px] font-medium">{consultant.name}</TableCell>
                            {WEEKDAY_LABELS.map((label, weekday) => (
                              <TableCell key={label} className="font-mono tabular-nums whitespace-nowrap text-[11px] text-muted-foreground">
                                {windowText(consultant.windows, weekday)}
                              </TableCell>
                            ))}
                            {canManage && (
                              <TableCell className="text-right">
                                <Button size="sm" variant="ghost" className="h-7 rounded-none" onClick={() => setEditing({ kind: "hours", studio, userId: consultant.userId })}>Edit</Button>
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      {editing?.kind === "studio" && <StudioDialog studio={editing.studio} onClose={close} onSaved={saved} />}
      {editing?.kind === "rooms" && <RoomsDialog studio={editing.studio} onClose={close} onSaved={saved} />}
      {editing?.kind === "hours" && (
        <HoursDialog studio={editing.studio} userId={editing.userId} consultants={directory.consultants} onClose={close} onSaved={saved} />
      )}
    </StudioShell>
  )
}

function useSave(onSaved: () => void) {
  const [pending, startTransition] = useTransition()
  const save = (work: () => Promise<unknown>, failure: string) =>
    startTransition(async () => {
      try {
        await work()
        onSaved()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  return { pending, save }
}

function StudioDialog({ studio, onClose, onSaved }: { studio: StudioLocationDto | null; onClose: () => void; onSaved: () => void }) {
  const { pending, save } = useSave(onSaved)
  const [timeZone, setTimeZone] = useState(studio?.timeZone ?? US_TIMEZONES[0].value)
  const [archived, setArchived] = useState(studio?.isArchived ?? false)

  function submit(formData: FormData) {
    save(async () => unwrapAction(await saveStudioLocationAction({
      id: studio?.id,
      name: String(formData.get("name") ?? ""),
      address: String(formData.get("address") ?? "") || null,
      timeZone,
      divisionId: studio?.divisionId ?? null,
      isArchived: archived,
    })), "Could not save the studio")
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="rounded-none">
        <form action={submit}>
          <DialogHeader>
            <DialogTitle>{studio ? `Edit ${studio.name}` : "Add a design studio"}</DialogTitle>
            <DialogDescription>Consultant hours and session times at this studio read in its time zone.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="studio-name">Name</Label>
              <Input id="studio-name" name="name" required maxLength={120} defaultValue={studio?.name ?? ""} className="rounded-none" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-address">Address</Label>
              <Input id="studio-address" name="address" maxLength={500} defaultValue={studio?.address ?? ""} className="rounded-none" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="studio-zone">Time zone</Label>
              <Select value={timeZone} onValueChange={setTimeZone}>
                <SelectTrigger id="studio-zone" className="rounded-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {[...US_TIMEZONES, ...(US_TIMEZONES.some((zone) => zone.value === timeZone) ? [] : [{ value: timeZone, label: timeZone }])].map((zone) => (
                    <SelectItem key={zone.value} value={zone.value}>{zone.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {studio && (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={archived} onCheckedChange={(checked) => setArchived(checked === true)} />
                Closed: take no new bookings here
              </label>
            )}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending} className="rounded-none">Save studio</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RoomsDialog({ studio, onClose, onSaved }: { studio: StudioLocationDto; onClose: () => void; onSaved: () => void }) {
  const { pending, save } = useSave(onSaved)
  const [rooms, setRooms] = useState(studio.rooms.map((room) => ({ ...room, key: room.id })))

  function submit() {
    save(async () => unwrapAction(await saveStudioRoomsAction({
      locationId: studio.id,
      rooms: rooms.map((room) => ({ id: room.id || undefined, name: room.name, isActive: room.isActive })),
    })), "Could not save the rooms")
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="rounded-none">
        <DialogHeader>
          <DialogTitle>Rooms at {studio.name}</DialogTitle>
          <DialogDescription>Each room in service holds one session at a time. A room with sessions ahead cannot be taken out of service.</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4">
          {rooms.length === 0 && <p className="text-sm text-muted-foreground">No rooms yet.</p>}
          {rooms.map((room, index) => (
            <div key={room.key} className="flex items-center gap-2">
              <Input
                aria-label={`Room ${index + 1} name`}
                value={room.name}
                maxLength={80}
                onChange={(event) => setRooms((current) => current.map((candidate) => candidate.key === room.key ? { ...candidate, name: event.target.value } : candidate))}
                className="rounded-none"
              />
              <label className="flex flex-none items-center gap-1.5 text-[12.5px]">
                <Checkbox
                  checked={room.isActive}
                  onCheckedChange={(checked) => setRooms((current) => current.map((candidate) => candidate.key === room.key ? { ...candidate, isActive: checked === true } : candidate))}
                />
                In service
              </label>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 rounded-none"
            onClick={() => setRooms((current) => [...current, { id: "", key: `new-${current.length}`, name: `Room ${current.length + 1}`, isActive: true }])}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add room
          </Button>
        </div>
        <DialogFooter>
          <Button disabled={pending || rooms.some((room) => !room.name.trim())} onClick={submit} className="rounded-none">Save rooms</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function HoursDialog({
  studio,
  userId,
  consultants,
  onClose,
  onSaved,
}: {
  studio: StudioLocationDto
  userId: string | null
  consultants: StudioDirectory["consultants"]
  onClose: () => void
  onSaved: () => void
}) {
  const { pending, save } = useSave(onSaved)
  const [consultantId, setConsultantId] = useState(userId ?? "")
  const existing = studio.consultants.find((consultant) => consultant.userId === consultantId)?.windows ?? []
  const [days, setDays] = useState(() =>
    WEEKDAY_LABELS.map((_, weekday) => {
      const window = existing.find((candidate) => candidate.weekday === weekday)
      return { working: Boolean(window), start: toClock(window?.startMinute ?? 9 * 60), end: toClock(window?.endMinute ?? 17 * 60) }
    }),
  )

  function submit() {
    const windows = days.flatMap((day, weekday) => day.working ? [{ weekday, startMinute: fromClock(day.start, false), endMinute: fromClock(day.end, true) }] : [])
    save(async () => unwrapAction(await saveConsultantHoursAction({ locationId: studio.id, userId: consultantId, windows })), "Could not save the hours")
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="rounded-none">
        <DialogHeader>
          <DialogTitle>Hours at {studio.name}</DialogTitle>
          <DialogDescription>In {studio.timeZone.replace("_", " ")} time. A consultant&apos;s hours at different studios never overlap.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-4">
          {userId === null && (
            <div className="space-y-1.5">
              <Label htmlFor="hours-consultant">Consultant</Label>
              {consultants.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nobody holds the design studio permission yet.</p>
              ) : (
                <Select value={consultantId} onValueChange={setConsultantId}>
                  <SelectTrigger id="hours-consultant" className="rounded-none"><SelectValue placeholder="Choose a consultant" /></SelectTrigger>
                  <SelectContent>
                    {consultants.map((consultant) => <SelectItem key={consultant.userId} value={consultant.userId}>{consultant.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            {days.map((day, weekday) => (
              <div key={WEEKDAY_LABELS[weekday]} className="grid grid-cols-[72px_1fr_1fr] items-center gap-2">
                <label className="flex items-center gap-1.5 text-[12.5px]">
                  <Checkbox
                    checked={day.working}
                    onCheckedChange={(checked) => setDays((current) => current.map((candidate, index) => index === weekday ? { ...candidate, working: checked === true } : candidate))}
                  />
                  {WEEKDAY_LABELS[weekday]}
                </label>
                <Input
                  type="time"
                  aria-label={`${WEEKDAY_LABELS[weekday]} start`}
                  value={day.start}
                  disabled={!day.working}
                  onChange={(event) => setDays((current) => current.map((candidate, index) => index === weekday ? { ...candidate, start: event.target.value } : candidate))}
                  className="h-8 rounded-none"
                />
                <Input
                  type="time"
                  aria-label={`${WEEKDAY_LABELS[weekday]} end`}
                  value={day.end}
                  disabled={!day.working}
                  onChange={(event) => setDays((current) => current.map((candidate, index) => index === weekday ? { ...candidate, end: event.target.value } : candidate))}
                  className="h-8 rounded-none"
                />
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button disabled={pending || !consultantId} onClick={submit} className="rounded-none">Save hours</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The loading state holds the workbench's shape: a studio header, its rooms and its hours table. */
export function StudiosSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 2 }, (_, index) => (
        <div key={index} className="border-b border-border px-5 py-4">
          <Skeleton className="h-5 w-48 rounded-none" />
          <Skeleton className="mt-1.5 h-3.5 w-64 rounded-none" />
          <div className="mt-3 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
            <div className="space-y-1.5">{Array.from({ length: 3 }, (_, row) => <Skeleton key={row} className="h-6 rounded-none" />)}</div>
            <div className="space-y-1.5">{Array.from({ length: 3 }, (_, row) => <Skeleton key={row} className="h-8 rounded-none" />)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
