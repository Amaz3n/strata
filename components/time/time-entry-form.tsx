"use client"

import { type CSSProperties, type Dispatch, type SetStateAction, useCallback, useMemo, useRef, useState } from "react"
import { format, isAfter, subDays } from "date-fns"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Calendar as CalendarPicker } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Drawer, DrawerContent } from "@/components/ui/drawer"
import { CalendarDays, Camera, Clock, Minus, Plus, Send, X } from "@/components/icons"

import type { CreateMyTimeEntryInput, CreateTimeEntriesInput } from "@/app/(app)/projects/[id]/time/actions"

type DateOption = "today" | "yesterday" | "custom"

interface CostCodeOption {
  id: string
  code?: string | null
  name?: string | null
}

interface TimeEntryFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  costCodes?: CostCodeOption[]
  workerSuggestions?: string[]
  rateSuggestions?: number[]
  crewMembers?: CrewMemberOption[]
  defaultBurdenMultiplier?: number
  canManageCrew?: boolean
  onSubmitSelf: (payload: CreateMyTimeEntryInput, attachment: File | null) => Promise<void>
  onSubmitCrew?: (payload: CreateTimeEntriesInput, attachment: File | null) => Promise<void>
  isSubmitting?: boolean
}

interface CrewMemberOption {
  membershipId: string
  userId: string
  name: string
  email?: string
  costRateDollars: number
  billRateDollars?: number
  burdenMultiplier: number
  isBillable: boolean
}

interface CrewDraftLine {
  id: string
  memberUserId?: string
  workerName: string
  hours: number
  baseRateDollars: number
  burdenMultiplier: number
  isBillable: boolean
  costCodeId?: string | null
}

const HOUR_CHIPS = [4, 6, 8, 10, 12]
const HOURS_MAX = 24
const HOURS_STEP = 0.25

function clampHours(value: number) {
  if (!Number.isFinite(value)) return 0
  const snapped = Math.round(value / HOURS_STEP) * HOURS_STEP
  return Math.min(HOURS_MAX, Math.max(0, Number(snapped.toFixed(2))))
}

export function TimeEntryForm(props: TimeEntryFormProps) {
  const isMobile = useIsMobile()
  return isMobile ? <MobileTimeEntryDrawer {...props} /> : <DesktopTimeEntrySheet {...props} />
}

/* ------------------------------- shared state ------------------------------ */

function useDateState() {
  const today = useMemo(() => new Date(), [])
  const [selectedDate, setSelectedDate] = useState<DateOption>("today")
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined)
  const [datePickerOpen, setDatePickerOpen] = useState(false)

  const workDateString = useMemo(() => {
    if (selectedDate === "today") return format(today, "yyyy-MM-dd")
    if (selectedDate === "yesterday") return format(subDays(today, 1), "yyyy-MM-dd")
    if (customDate) return format(customDate, "yyyy-MM-dd")
    return format(today, "yyyy-MM-dd")
  }, [selectedDate, customDate, today])

  function reset() {
    setSelectedDate("today")
    setCustomDate(undefined)
  }

  return {
    today,
    selectedDate,
    setSelectedDate,
    customDate,
    setCustomDate,
    datePickerOpen,
    setDatePickerOpen,
    workDateString,
    reset,
  }
}

function DateChips({
  today,
  selectedDate,
  setSelectedDate,
  customDate,
  setCustomDate,
  datePickerOpen,
  setDatePickerOpen,
  size = "sm",
}: ReturnType<typeof useDateState> & { size?: "sm" | "md" }) {
  const padding = size === "md" ? "px-4 py-2 text-sm" : "px-3 py-1.5 text-xs"
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setSelectedDate("today")
          setCustomDate(undefined)
        }}
        className={cn(
          "font-medium rounded-full transition-colors",
          padding,
          selectedDate === "today"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted/80",
        )}
      >
        Today
      </button>
      <button
        type="button"
        onClick={() => {
          setSelectedDate("yesterday")
          setCustomDate(undefined)
        }}
        className={cn(
          "font-medium rounded-full transition-colors",
          padding,
          selectedDate === "yesterday"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-muted-foreground hover:bg-muted/80",
        )}
      >
        Yesterday
      </button>
      <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1 font-medium rounded-full transition-colors",
              padding,
              selectedDate === "custom"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
          >
            <CalendarDays className="h-3 w-3" />
            {selectedDate === "custom" && customDate ? format(customDate, "MMM d") : "Pick"}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <CalendarPicker
            mode="single"
            selected={customDate}
            onSelect={(date) => {
              if (date) {
                setCustomDate(date)
                setSelectedDate("custom")
                setDatePickerOpen(false)
              }
            }}
            disabled={(date) => isAfter(date, today)}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}

/* ------------------------------- hours picker ------------------------------ */

interface HoursPickerProps {
  value: number
  onChange: (value: number) => void
  size?: "sm" | "md"
}

function HoursPicker({ value, onChange, size = "md" }: HoursPickerProps) {
  const isChipMatch = (chip: number) => Math.abs(value - chip) < 0.001
  const chipBase =
    size === "md"
      ? "h-12 min-w-[56px] px-3 text-base"
      : "h-10 min-w-[48px] px-3 text-sm"
  const displayClass =
    size === "md" ? "text-3xl font-semibold tabular-nums" : "text-2xl font-semibold tabular-nums"

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-1.5">
        {HOUR_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => onChange(chip)}
            className={cn(
              "rounded-full font-medium border transition-colors",
              chipBase,
              isChipMatch(chip)
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            {chip}h
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between rounded-2xl border bg-card px-3 py-2">
        <button
          type="button"
          onClick={() => onChange(clampHours(value - HOURS_STEP))}
          disabled={value <= 0}
          className="h-10 w-10 inline-flex items-center justify-center rounded-full border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
          aria-label="Decrease hours"
        >
          <Minus className="h-4 w-4" />
        </button>

        <div className="flex flex-col items-center">
          <span className={displayClass}>{value > 0 ? value.toFixed(2) : "0.00"}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">hours</span>
        </div>

        <button
          type="button"
          onClick={() => onChange(clampHours(value + HOURS_STEP))}
          disabled={value >= HOURS_MAX}
          className="h-10 w-10 inline-flex items-center justify-center rounded-full border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40"
          aria-label="Increase hours"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/* ------------------------------- self state ------------------------------- */

function useSelfModeState() {
  const [hours, setHours] = useState<number>(0)
  const [isOvertime, setIsOvertime] = useState(false)
  const [otMultiplier, setOtMultiplier] = useState(1.5)
  const [isDoubleTime, setIsDoubleTime] = useState(false)
  const [dtMultiplier, setDtMultiplier] = useState(2)
  const [notes, setNotes] = useState("")
  const [attachment, setAttachment] = useState<File | null>(null)
  function reset() {
    setHours(0)
    setIsOvertime(false)
    setOtMultiplier(1.5)
    setIsDoubleTime(false)
    setDtMultiplier(2)
    setNotes("")
    setAttachment(null)
  }
  return { hours, setHours, isOvertime, setIsOvertime, otMultiplier, setOtMultiplier, isDoubleTime, setIsDoubleTime, dtMultiplier, setDtMultiplier, notes, setNotes, attachment, setAttachment, reset }
}

function useCrewModeState(crewMembers: CrewMemberOption[], defaultBurdenMultiplier = 1) {
  const first = crewMembers[0]
  const createLine = (member?: CrewMemberOption): CrewDraftLine => ({
    id: crypto.randomUUID(),
    memberUserId: member?.userId,
    workerName: member?.name ?? "",
    hours: 8,
    baseRateDollars: member?.costRateDollars ?? 0,
    burdenMultiplier: member?.burdenMultiplier ?? defaultBurdenMultiplier,
    isBillable: member?.isBillable ?? true,
    costCodeId: null,
  })
  const [lines, setLines] = useState<CrewDraftLine[]>(() => [createLine(first)])
  const [isOvertime, setIsOvertime] = useState(false)
  const [otMultiplier, setOtMultiplier] = useState(1.5)
  const [isDoubleTime, setIsDoubleTime] = useState(false)
  const [dtMultiplier, setDtMultiplier] = useState(2)
  const [notes, setNotes] = useState("")
  const [attachment, setAttachment] = useState<File | null>(null)

  function reset() {
    setLines([createLine(first)])
    setIsOvertime(false)
    setOtMultiplier(1.5)
    setIsDoubleTime(false)
    setDtMultiplier(2)
    setNotes("")
    setAttachment(null)
  }

  return { lines, setLines, isOvertime, setIsOvertime, otMultiplier, setOtMultiplier, isDoubleTime, setIsDoubleTime, dtMultiplier, setDtMultiplier, notes, setNotes, attachment, setAttachment, reset, createLine }
}

function OvertimeFields({
  isOvertime,
  setIsOvertime,
  otMultiplier,
  setOtMultiplier,
  isDoubleTime,
  setIsDoubleTime,
  dtMultiplier,
  setDtMultiplier,
}: {
  isOvertime: boolean
  setIsOvertime: (value: boolean) => void
  otMultiplier: number
  setOtMultiplier: (value: number) => void
  isDoubleTime: boolean
  setIsDoubleTime: (value: boolean) => void
  dtMultiplier: number
  setDtMultiplier: (value: number) => void
}) {
  const premiumActive = isOvertime || isDoubleTime
  const multiplier = isDoubleTime ? dtMultiplier : otMultiplier
  const setMultiplier = isDoubleTime ? setDtMultiplier : setOtMultiplier

  return (
    <div className="rounded-lg border bg-muted/20 px-3 py-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3">
        <Label className="text-sm font-medium" htmlFor="time-entry-overtime">
          OT
        </Label>
        <Switch
          id="time-entry-overtime"
          checked={isOvertime}
          onCheckedChange={(checked) => {
            setIsOvertime(checked)
            if (checked) setIsDoubleTime(false)
          }}
        />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm font-medium" htmlFor="time-entry-double-time">
            DT
          </Label>
          <Switch
            id="time-entry-double-time"
            checked={isDoubleTime}
            onCheckedChange={(checked) => {
              setIsDoubleTime(checked)
              if (checked) setIsOvertime(false)
            }}
          />
        </div>
      </div>
      {premiumActive ? (
        <div className="mt-3 grid grid-cols-[1fr_96px] items-center gap-3">
          <Label htmlFor="time-entry-premium-multiplier" className="text-xs text-muted-foreground">
            Multiplier
          </Label>
          <Input
            id="time-entry-premium-multiplier"
            value={String(multiplier)}
            onChange={(event) => {
              const next = Number(event.target.value)
              setMultiplier(Number.isFinite(next) && next >= 1 ? next : isDoubleTime ? 2 : 1.5)
            }}
            inputMode="decimal"
            min={1}
            max={4}
            step={0.05}
            className="h-9 text-right"
          />
        </div>
      ) : null}
    </div>
  )
}

function CrewEditor({
  lines,
  setLines,
  createLine,
  crewMembers = [],
  costCodes = [],
}: {
  lines: CrewDraftLine[]
  setLines: Dispatch<SetStateAction<CrewDraftLine[]>>
  createLine: (member?: CrewMemberOption) => CrewDraftLine
  crewMembers?: CrewMemberOption[]
  costCodes?: CostCodeOption[]
}) {
  const sortedCostCodes = useMemo(
    () => [...costCodes].sort((a, b) => `${a.code ?? ""} ${a.name ?? ""}`.localeCompare(`${b.code ?? ""} ${b.name ?? ""}`)),
    [costCodes],
  )
  const byUserId = useMemo(() => new Map(crewMembers.map((member) => [member.userId, member])), [crewMembers])

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">Crew</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => setLines((prev) => [...prev, createLine()])}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          Add
        </Button>
      </div>
      <div className="space-y-3">
        {lines.map((line) => (
          <div key={line.id} className="rounded-xl border bg-card p-3 space-y-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_88px_112px_36px]">
              {crewMembers.length > 0 ? (
                <Select
                  value={line.memberUserId ?? "__manual__"}
                  onValueChange={(value) => {
                    if (value === "__manual__") {
                      setLines((prev) =>
                        prev.map((item) => (item.id === line.id ? { ...item, memberUserId: undefined, workerName: "" } : item)),
                      )
                      return
                    }
                    const member = byUserId.get(value)
                    if (!member) return
                    setLines((prev) =>
                      prev.map((item) =>
                        item.id === line.id
                          ? {
                              ...item,
                              memberUserId: member.userId,
                              workerName: member.name,
                              baseRateDollars: member.costRateDollars,
                              burdenMultiplier: member.burdenMultiplier,
                              isBillable: member.isBillable,
                            }
                          : item,
                      ),
                    )
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Employee" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__manual__">Manual worker</SelectItem>
                    {crewMembers.map((member) => (
                      <SelectItem key={member.userId} value={member.userId}>
                        {member.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={line.workerName}
                  onChange={(event) =>
                    setLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, workerName: event.target.value } : item)))
                  }
                  placeholder="Worker name"
                />
              )}
              <Input
                value={line.hours ? String(line.hours) : ""}
                onChange={(event) =>
                  setLines((prev) =>
                    prev.map((item) =>
                      item.id === line.id ? { ...item, hours: clampHours(Number(event.target.value) || 0) } : item,
                    ),
                  )
                }
                inputMode="decimal"
                placeholder="Hours"
              />
              <Input
                value={line.baseRateDollars ? String(line.baseRateDollars) : ""}
                onChange={(event) =>
                  setLines((prev) =>
                    prev.map((item) =>
                      item.id === line.id ? { ...item, baseRateDollars: Number(event.target.value) || 0 } : item,
                    ),
                  )
                }
                inputMode="decimal"
                placeholder="Rate"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={lines.length === 1}
                onClick={() => setLines((prev) => prev.filter((item) => item.id !== line.id))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {crewMembers.length > 0 && !line.memberUserId ? (
              <Input
                value={line.workerName}
                onChange={(event) =>
                  setLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, workerName: event.target.value } : item)))
                }
                placeholder="Worker name"
              />
            ) : null}
            <Select
              value={line.costCodeId ?? "__none__"}
              onValueChange={(value) =>
                setLines((prev) =>
                  prev.map((item) => (item.id === line.id ? { ...item, costCodeId: value === "__none__" ? null : value } : item)),
                )
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Cost code" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Review queue assigns cost code</SelectItem>
                {sortedCostCodes.map((code) => (
                  <SelectItem key={code.id} value={code.id}>
                    {code.code ? `${code.code} - ${code.name}` : code.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------- DESKTOP SHEET ------------------------------ */

function DesktopTimeEntrySheet({
  open,
  onOpenChange,
  costCodes = [],
  crewMembers = [],
  defaultBurdenMultiplier = 1,
  canManageCrew,
  onSubmitSelf,
  onSubmitCrew,
  isSubmitting,
}: TimeEntryFormProps) {
  const date = useDateState()
  const self = useSelfModeState()
  const crew = useCrewModeState(crewMembers, defaultBurdenMultiplier)
  const [mode, setMode] = useState<"self" | "crew">("self")
  const fileRef = useRef<HTMLInputElement>(null)

  const resetAll = useCallback(() => {
    date.reset()
    self.reset()
    crew.reset()
  }, [date, self, crew])

  async function submit() {
    if (mode === "crew") {
      const validCrew = crew.lines.filter((line) => line.workerName.trim() && line.hours > 0)
      if (!onSubmitCrew || validCrew.length === 0) {
        toast.error("Add at least one crew member with hours")
        return
      }
      await onSubmitCrew(
        {
          workDate: date.workDateString,
          burdenMultiplier: defaultBurdenMultiplier,
          isBillable: true,
          isOvertime: crew.isOvertime,
          otMultiplier: crew.otMultiplier,
          isDoubleTime: crew.isDoubleTime,
          dtMultiplier: crew.dtMultiplier,
          notes: crew.notes.trim() || null,
          crew: validCrew.map((line) => ({
            workerUserId: line.memberUserId ?? null,
            workerName: line.workerName,
            hours: line.hours,
            baseRateDollars: line.baseRateDollars,
            burdenMultiplier: line.burdenMultiplier,
            isBillable: line.isBillable,
            costCodeId: line.costCodeId ?? null,
          })),
        },
        crew.attachment,
      )
      resetAll()
      return
    }

    if (self.hours <= 0) {
      toast.error("Enter how many hours you worked")
      return
    }
    try {
      await onSubmitSelf(
        {
          workDate: date.workDateString,
          hours: self.hours,
          isOvertime: self.isOvertime,
          otMultiplier: self.otMultiplier,
          isDoubleTime: self.isDoubleTime,
          dtMultiplier: self.dtMultiplier,
          notes: self.notes.trim() || null,
        },
        self.attachment,
      )
      resetAll()
    } catch {
      // parent toasts
    }
  }

  const submitDisabled =
    isSubmitting ||
    (mode === "self"
      ? self.hours <= 0
      : !crew.lines.some((line) => line.workerName.trim().length > 0 && line.hours > 0))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" />
            Log my time
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Pick the date, hours, and crew. Employee rates come from Team settings.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {canManageCrew ? (
            <div className="grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
              {(["self", "crew"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors",
                    mode === option ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option === "self" ? "My time" : "Crew"}
                </button>
              ))}
            </div>
          ) : null}

          <div>
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">Date</Label>
            <div className="mt-2">
              <DateChips {...date} />
            </div>
          </div>

          {mode === "crew" ? (
            <>
              <CrewEditor
                lines={crew.lines}
                setLines={crew.setLines}
                createLine={crew.createLine}
                crewMembers={crewMembers}
                costCodes={costCodes}
              />
              <OvertimeFields
                isOvertime={crew.isOvertime}
                setIsOvertime={crew.setIsOvertime}
                otMultiplier={crew.otMultiplier}
                setOtMultiplier={crew.setOtMultiplier}
                isDoubleTime={crew.isDoubleTime}
                setIsDoubleTime={crew.setIsDoubleTime}
                dtMultiplier={crew.dtMultiplier}
                setDtMultiplier={crew.setDtMultiplier}
              />
              <Textarea
                rows={3}
                value={crew.notes}
                onChange={(event) => crew.setNotes(event.target.value)}
                placeholder="Crew notes (optional)"
                className="text-sm"
              />
            </>
          ) : (
            <>
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Hours worked</Label>
                <div className="mt-2">
                  <HoursPicker value={self.hours} onChange={self.setHours} />
                </div>
              </div>

              <OvertimeFields
                isOvertime={self.isOvertime}
                setIsOvertime={self.setIsOvertime}
                otMultiplier={self.otMultiplier}
                setOtMultiplier={self.setOtMultiplier}
                isDoubleTime={self.isDoubleTime}
                setIsDoubleTime={self.setIsDoubleTime}
                dtMultiplier={self.dtMultiplier}
                setDtMultiplier={self.setDtMultiplier}
              />

              <div className="space-y-1.5">
                <Label htmlFor="self-notes" className="text-xs text-muted-foreground">
                  Notes <span className="text-muted-foreground/60">(optional)</span>
                </Label>
                <Textarea
                  id="self-notes"
                  rows={3}
                  value={self.notes}
                  onChange={(event) => self.setNotes(event.target.value)}
                  placeholder="What were you working on?"
                  className="text-sm"
                />
              </div>
            </>
          )}

          {(mode === "crew" ? crew.attachment : self.attachment) ? (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Camera className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate flex-1">{(mode === "crew" ? crew.attachment : self.attachment)?.name}</span>
              <button
                type="button"
                onClick={() => (mode === "crew" ? crew.setAttachment(null) : self.setAttachment(null))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              if (mode === "crew") crew.setAttachment(file)
              else self.setAttachment(file)
              event.target.value = ""
            }}
          />
        </div>

        <SheetFooter className="border-t bg-background/80 px-6 py-3 flex flex-row items-center gap-2">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          >
            <Camera className="h-3.5 w-3.5" />
            {(mode === "crew" ? crew.attachment : self.attachment) ? "Replace" : "Attach"}
          </button>

          <div className="flex-1" />

          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={submitDisabled} className="gap-1.5">
            {isSubmitting ? (
              "Submitting..."
            ) : (
              <>
                <span>Submit</span>
                <Send className="h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/* ------------------------------- MOBILE DRAWER ----------------------------- */

function MobileTimeEntryDrawer({
  open,
  onOpenChange,
  costCodes = [],
  crewMembers = [],
  defaultBurdenMultiplier = 1,
  canManageCrew,
  onSubmitSelf,
  onSubmitCrew,
  isSubmitting,
}: TimeEntryFormProps) {
  const date = useDateState()
  const self = useSelfModeState()
  const crew = useCrewModeState(crewMembers, defaultBurdenMultiplier)
  const [mode, setMode] = useState<"self" | "crew">("self")
  const fileRef = useRef<HTMLInputElement>(null)

  const resetAll = useCallback(() => {
    date.reset()
    self.reset()
    crew.reset()
  }, [date, self, crew])

  async function submit() {
    if (mode === "crew") {
      const validCrew = crew.lines.filter((line) => line.workerName.trim() && line.hours > 0)
      if (!onSubmitCrew || validCrew.length === 0) {
        toast.error("Add at least one crew member with hours")
        return
      }
      await onSubmitCrew(
        {
          workDate: date.workDateString,
          burdenMultiplier: defaultBurdenMultiplier,
          isBillable: true,
          isOvertime: crew.isOvertime,
          otMultiplier: crew.otMultiplier,
          isDoubleTime: crew.isDoubleTime,
          dtMultiplier: crew.dtMultiplier,
          notes: crew.notes.trim() || null,
          crew: validCrew.map((line) => ({
            workerUserId: line.memberUserId ?? null,
            workerName: line.workerName,
            hours: line.hours,
            baseRateDollars: line.baseRateDollars,
            burdenMultiplier: line.burdenMultiplier,
            isBillable: line.isBillable,
            costCodeId: line.costCodeId ?? null,
          })),
        },
        crew.attachment,
      )
      resetAll()
      return
    }

    if (self.hours <= 0) {
      toast.error("Enter how many hours you worked")
      return
    }
    try {
      await onSubmitSelf(
        {
          workDate: date.workDateString,
          hours: self.hours,
          isOvertime: self.isOvertime,
          otMultiplier: self.otMultiplier,
          isDoubleTime: self.isDoubleTime,
          dtMultiplier: self.dtMultiplier,
          notes: self.notes.trim() || null,
        },
        self.attachment,
      )
      resetAll()
    } catch {
      // toasted upstream
    }
  }

  const submitDisabled =
    isSubmitting ||
    (mode === "self"
      ? self.hours <= 0
      : !crew.lines.some((line) => line.workerName.trim().length > 0 && line.hours > 0))

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mx-auto max-w-lg outline-none flex flex-col max-h-[92vh]">
        <div className="flex items-center justify-between px-4 pt-4 pb-1">
          <DateChips {...date} size="md" />
        </div>

        <div className="flex-1 overflow-y-auto p-4 pt-3 pb-2 space-y-4">
          {canManageCrew ? (
            <div className="grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
              {(["self", "crew"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setMode(option)}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm font-medium capitalize transition-colors",
                    mode === option ? "bg-background shadow-sm" : "text-muted-foreground",
                  )}
                >
                  {option === "self" ? "My time" : "Crew"}
                </button>
              ))}
            </div>
          ) : null}

          {mode === "crew" ? (
            <>
              <CrewEditor
                lines={crew.lines}
                setLines={crew.setLines}
                createLine={crew.createLine}
                crewMembers={crewMembers}
                costCodes={costCodes}
              />
              <OvertimeFields
                isOvertime={crew.isOvertime}
                setIsOvertime={crew.setIsOvertime}
                otMultiplier={crew.otMultiplier}
                setOtMultiplier={crew.setOtMultiplier}
                isDoubleTime={crew.isDoubleTime}
                setIsDoubleTime={crew.setIsDoubleTime}
                dtMultiplier={crew.dtMultiplier}
                setDtMultiplier={crew.setDtMultiplier}
              />
              <Textarea
                value={crew.notes}
                onChange={(event) => crew.setNotes(event.target.value)}
                placeholder="Crew notes (optional)"
                rows={3}
                className="text-sm"
              />
            </>
          ) : (
            <>
              <HoursPicker value={self.hours} onChange={self.setHours} />
              <OvertimeFields
                isOvertime={self.isOvertime}
                setIsOvertime={self.setIsOvertime}
                otMultiplier={self.otMultiplier}
                setOtMultiplier={self.setOtMultiplier}
                isDoubleTime={self.isDoubleTime}
                setIsDoubleTime={self.setIsDoubleTime}
                dtMultiplier={self.dtMultiplier}
                setDtMultiplier={self.setDtMultiplier}
              />
              <Textarea
                value={self.notes}
                onChange={(event) => self.setNotes(event.target.value)}
                placeholder="Notes (optional)"
                rows={3}
                className="text-sm"
              />
            </>
          )}

          {(mode === "crew" ? crew.attachment : self.attachment) ? (
            <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs">
              <Camera className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="truncate flex-1">{(mode === "crew" ? crew.attachment : self.attachment)?.name}</span>
              <button
                type="button"
                onClick={() => (mode === "crew" ? crew.setAttachment(null) : self.setAttachment(null))}
                className="text-muted-foreground hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              if (mode === "crew") crew.setAttachment(file)
              else self.setAttachment(file)
              event.target.value = ""
            }}
          />
        </div>

        <div className="flex-shrink-0 border-t bg-background px-4 py-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
            >
              <Camera className="h-4 w-4" />
              <span className="text-xs font-medium">Photo</span>
              {(mode === "crew" ? crew.attachment : self.attachment) ? <span className="text-xs text-primary">(1)</span> : null}
            </button>

            <Button
              type="button"
              size="sm"
              disabled={submitDisabled}
              onClick={submit}
              className="gap-1.5 px-4"
            >
              {isSubmitting ? (
                "Logging..."
              ) : (
                <>
                  <span>{mode === "crew" ? "Log crew" : "Log time"}</span>
                  <Send className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
