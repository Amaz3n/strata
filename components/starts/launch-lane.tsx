"use client"

import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { AlertTriangle, HardHat, Plus } from "@/components/icons"
import { CANDIDATE_PREFIX, CandidateCard, StartCard, formatDay } from "@/components/starts/start-card"
import { SlotMeter } from "@/components/starts/slot-meter"
import { StartPackageSheet } from "@/components/starts/start-package-sheet"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { StartsDesk } from "@/lib/services/starts-desk"
import type { StartPackageListItemDTO } from "@/lib/services/starts"
import { mondayOfIsoWeek } from "@/lib/starts/even-flow-math"
import { cn } from "@/lib/utils"
import {
  openStartPackageAction, releaseStartsAction, setReleaseSlotAction, setStartTargetWeekAction,
} from "@/app/(app)/starts/actions"

import "./starts.css"

type Focus = "all" | "ready" | "at_risk" | "failed" | "sold"

const WEEK_PREFIX = "week:"
const YARD_ID = "yard"

function matchesFocus(pkg: StartPackageListItemDTO, focus: Focus) {
  switch (focus) {
    case "ready": return pkg.status === "ready"
    case "at_risk": return pkg.risk === "at_risk" || pkg.risk === "late"
    case "failed": return pkg.status === "attention"
    case "sold": return pkg.sale.isSold
    default: return true
  }
}

function WeekColumn({ week, index, currentWeek, children, canDrop }: {
  week: StartsDesk["weeks"][number]
  index: number
  currentWeek: string
  children: React.ReactNode
  canDrop: boolean
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${WEEK_PREFIX}${week.weekStart}`, disabled: !canDrop })
  return (
    <div
      ref={setNodeRef}
      className="lane-column flex flex-col"
      data-parity={index % 2}
      data-current={week.weekStart === currentWeek}
      data-past={week.weekStart < currentWeek}
      data-dropping={isOver}
    >
      {children}
    </div>
  )
}

interface Props {
  desk: StartsDesk
  /** Communities in scope — drives whether cards need a community label. */
  communities: Array<{ id: string; name: string }>
  /** Selected community, when the desk is narrowed to one. */
  communityId?: string
  /** Set on the org desk to render the scope picker; omitted when embedded. */
  scopeBasePath?: string
  /** Deep link from /starts/[id] — opens straight into a package. */
  initialPackageId?: string
}

export function LaunchLane({ desk, communities, communityId, scopeBasePath, initialPackageId }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [focus, setFocus] = useState<Focus>("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sheetId, setSheetId] = useState<string | null>(initialPackageId ?? null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [slotEditor, setSlotEditor] = useState<{ communityId: string; communityName: string; weekStart: string } | null>(null)
  const [slotTarget, setSlotTarget] = useState("")
  const [slotNotes, setSlotNotes] = useState("")
  const [openLotId, setOpenLotId] = useState<string | null>(null)
  const [openWeek, setOpenWeek] = useState<string | null>(null)
  const [openFinanced, setOpenFinanced] = useState(false)
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseDate, setReleaseDate] = useState("")
  const [overSlotIds, setOverSlotIds] = useState<string[]>([])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor))

  const visible = useMemo(() => desk.packages.filter((pkg) => matchesFocus(pkg, focus)), [desk.packages, focus])
  const byWeek = useMemo(() => {
    const map = new Map<string, StartPackageListItemDTO[]>()
    for (const pkg of visible) {
      if (!pkg.targetWeek) continue
      map.set(pkg.targetWeek, [...(map.get(pkg.targetWeek) ?? []), pkg])
    }
    return map
  }, [visible])
  const unslotted = useMemo(() => visible.filter((pkg) => !pkg.targetWeek), [visible])
  const candidates = useMemo(
    () => (focus === "all" || focus === "sold" ? desk.candidates.filter((candidate) => focus !== "sold" || candidate.sale.isSold) : []),
    [desk.candidates, focus],
  )
  const selectedPackages = useMemo(
    () => desk.packages.filter((pkg) => selected.has(pkg.id)),
    [desk.packages, selected],
  )
  function refresh() {
    setSelected(new Set())
    router.refresh()
  }

  function runAction(operation: () => Promise<unknown>, success: string, failure: string, after?: () => void) {
    startTransition(async () => {
      try {
        await operation()
        toast.success(success)
        after?.()
        refresh()
      } catch (error) {
        toast.error(failure, { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function toggleSelect(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleDragEnd(event: DragEndEvent) {
    setDraggingId(null)
    const activeId = String(event.active.id)
    const overId = event.over ? String(event.over.id) : null
    if (!overId) return
    const weekStart = overId.startsWith(WEEK_PREFIX) ? overId.slice(WEEK_PREFIX.length) : null
    if (!weekStart && overId !== YARD_ID) return

    if (activeId.startsWith(CANDIDATE_PREFIX)) {
      // Opening a package creates the preconstruction project this lot needs,
      // so the drop confirms rather than fires — with the week already chosen.
      if (!weekStart) return
      setOpenLotId(activeId.slice(CANDIDATE_PREFIX.length))
      setOpenWeek(weekStart)
      setOpenFinanced(false)
      return
    }
    const pkg = desk.packages.find((candidate) => candidate.id === activeId)
    if (!pkg || pkg.targetWeek === weekStart) return
    runAction(
      async () => { unwrapAction(await setStartTargetWeekAction(activeId, weekStart)) },
      weekStart ? `${pkg.lotLabel} targeted at week of ${formatDay(weekStart)}` : `${pkg.lotLabel} returned to the yard`,
      "Unable to retarget this house",
    )
  }

  function submitRelease(confirmOverSlot: boolean) {
    const ids = selectedPackages.map((pkg) => pkg.id)
    if (!ids.length || !releaseDate) return
    startTransition(async () => {
      try {
        const result = unwrapAction(await releaseStartsAction(ids, { scheduledStartDate: releaseDate, confirmOverSlot }))
        if (result.released.length) {
          toast.success(`${result.released.length} ${result.released.length === 1 ? "home" : "homes"} released — orchestration is running`)
        }
        for (const failure of result.failed) {
          const pkg = desk.packages.find((candidate) => candidate.id === failure.id)
          toast.error(`Unable to release ${pkg?.lotLabel ?? "a home"}`, { description: failure.error })
        }
        if (result.needsConfirm.length) {
          setOverSlotIds(result.needsConfirm.map((entry) => entry.id))
          if (result.released.length) router.refresh()
          return
        }
        setReleaseOpen(false)
        setOverSlotIds([])
        refresh()
      } catch (error) {
        toast.error("Unable to release", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  function beginRelease() {
    const earliest = selectedPackages.reduce<string | null>(
      (soonest, pkg) => (pkg.targetWeek && (!soonest || pkg.targetWeek < soonest) ? pkg.targetWeek : soonest),
      null,
    )
    const today = new Date().toISOString().slice(0, 10)
    setReleaseDate(earliest && earliest > today ? earliest : today)
    setOverSlotIds([])
    setReleaseOpen(true)
  }

  function saveSlot() {
    if (!slotEditor) return
    const next = Number(slotTarget)
    if (!Number.isInteger(next) || next < 0 || next > 20) {
      toast.error("Target must be a whole number between 0 and 20")
      return
    }
    runAction(
      async () => {
        unwrapAction(await setReleaseSlotAction(slotEditor.communityId, slotEditor.weekStart, {
          targetStarts: next, notes: slotNotes.trim() || null,
        }))
      },
      "Release target updated",
      "Unable to update release target",
      () => setSlotEditor(null),
    )
  }

  function openPackage() {
    if (!openLotId) return
    runAction(
      async () => { unwrapAction(await openStartPackageAction(openLotId, { isFinanced: openFinanced, targetWeek: openWeek })) },
      "Start package opened",
      "Unable to open start package",
      () => { setOpenLotId(null); setOpenWeek(null) },
    )
  }

  const counters: Array<{ key: Focus; label: string; value: number; tone?: string }> = [
    { key: "all", label: "in precon", value: desk.counters.precon },
    { key: "ready", label: "ready to release", value: desk.counters.ready },
    { key: "at_risk", label: "at risk", value: desk.counters.atRisk, tone: "text-warning" },
    { key: "failed", label: "release failed", value: desk.counters.failed, tone: "text-destructive" },
  ]

  if (!desk.weeks.length) {
    return (
      <Empty className="min-h-64 rounded-none border">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="rounded-none"><HardHat /></EmptyMedia>
          <EmptyTitle className="text-sm">No active communities</EmptyTitle>
          <EmptyDescription className="text-xs">
            The lane paces starts against a weekly target per community. Activate a community with developed lots to set the drumbeat.
          </EmptyDescription>
        </EmptyHeader>
        <Button asChild size="sm" variant="outline" className="rounded-none">
          <Link href="/communities">Go to communities</Link>
        </Button>
      </Empty>
    )
  }

  const laneEmpty = desk.packages.length === 0 && desk.candidates.length === 0

  return (
    <div className="lane flex min-h-0 flex-1 flex-col">
      {/* ===== Ribbon ===== */}
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1">
          {scopeBasePath && communities.length > 1 ? (
            <Select
              value={communityId ?? "org"}
              onValueChange={(value) => router.replace(value === "org" ? scopeBasePath : `${scopeBasePath}?community=${value}`)}
            >
              <SelectTrigger className="mr-2 h-7 w-44 rounded-none text-xs" aria-label="Community scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="org">All communities</SelectItem>
                {communities.map((community) => (
                  <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {counters.map((counter) => {
            const active = focus === counter.key
            return (
              <button
                key={counter.key}
                type="button"
                aria-pressed={active}
                onClick={() => setFocus(active && counter.key !== "all" ? "all" : counter.key)}
                className={cn(
                  "px-2 py-1 text-xs transition-colors",
                  active ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className={cn("font-semibold tabular-nums", !active && counter.tone)}>{counter.value}</span>{" "}
                {counter.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="tabular-nums">
            Next 4 weeks: {desk.counters.filledAhead} of {desk.counters.slotsAhead} slots filled
          </span>
          {desk.counters.soldAtRisk > 0 ? (
            <button
              type="button"
              onClick={() => setFocus("at_risk")}
              className="flex items-center gap-1.5 font-medium text-destructive hover:underline"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {desk.counters.soldAtRisk} sold {desk.counters.soldAtRisk === 1 ? "home" : "homes"} will miss its close
            </button>
          ) : null}
          {desk.truncated ? <span>Showing the first 200 packages — narrow by community.</span> : null}
        </div>
      </div>

      {laneEmpty ? (
        <Empty className="min-h-64 flex-1 rounded-none border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-none"><HardHat /></EmptyMedia>
            <EmptyTitle className="text-sm">Nothing in the start pipeline</EmptyTitle>
            <EmptyDescription className="text-xs">
              Developed lots appear in the yard on the left. Drag one into a week to open its start package and put it on the drumbeat.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={(event: DragStartEvent) => setDraggingId(String(event.active.id))}
          onDragCancel={() => setDraggingId(null)}
          onDragEnd={handleDragEnd}
        >
          <div className="flex min-h-0 flex-1">
            <Yard
              candidates={candidates}
              packages={unslotted}
              showCommunity={!communityId && communities.length > 1}
              canWrite={desk.canWrite}
              onOpenPackage={setSheetId}
              onOpenCandidate={(lotId) => { setOpenLotId(lotId); setOpenWeek(null); setOpenFinanced(false) }}
            />

            <div className="lane-track min-h-0 flex-1">
              {desk.weeks.map((week, index) => {
                const cards = byWeek.get(week.weekStart) ?? []
                const released = cards.filter((pkg) => pkg.status === "released").length
                const editable = desk.canSetSlots && week.perCommunity.length === 1
                return (
                  <WeekColumn key={week.weekStart} week={week} index={index} currentWeek={desk.currentWeek} canDrop={desk.canWrite}>
                    <div className="lane-column-head px-2.5 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={cn(
                          "text-[11px] uppercase tracking-wide",
                          week.weekStart === desk.currentWeek ? "font-semibold text-foreground" : "text-muted-foreground",
                        )}>
                          {week.weekStart === desk.currentWeek ? "This week" : formatDay(week.weekStart)}
                        </span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {cards.length}/{week.targetStarts}
                        </span>
                      </div>
                      {editable ? (
                        <button
                          type="button"
                          className="mt-1.5 block w-full text-left"
                          aria-label={`Set the start target for ${week.perCommunity[0].communityName}, week of ${formatDay(week.weekStart)}`}
                          onClick={() => {
                            setSlotTarget(String(week.perCommunity[0].targetStarts))
                            setSlotNotes("")
                            setSlotEditor({
                              communityId: week.perCommunity[0].communityId,
                              communityName: week.perCommunity[0].communityName,
                              weekStart: week.weekStart,
                            })
                          }}
                        >
                          <SlotMeter target={week.targetStarts} released={released} targeted={cards.length - released} />
                        </button>
                      ) : (
                        <div className="mt-1.5">
                          <SlotMeter target={week.targetStarts} released={released} targeted={cards.length - released} />
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 p-2">
                      {cards.map((pkg) => (
                        <StartCard
                          key={pkg.id}
                          pkg={pkg}
                          selected={selected.has(pkg.id)}
                          selectable={desk.canRelease && pkg.status === "ready"}
                          draggable={desk.canWrite && ["open", "ready"].includes(pkg.status)}
                          showCommunity={!communityId && communities.length > 1}
                          onOpen={setSheetId}
                          onToggleSelect={toggleSelect}
                        />
                      ))}
                    </div>
                  </WeekColumn>
                )
              })}
            </div>
          </div>

          <DragOverlay dropAnimation={null}>
            {draggingId ? (
              <div className="border border-primary bg-card px-2.5 py-1.5 text-[12px] font-medium shadow-lg">
                {draggingId.startsWith(CANDIDATE_PREFIX)
                  ? desk.candidates.find((candidate) => `${CANDIDATE_PREFIX}${candidate.lotId}` === draggingId)?.lotLabel
                  : desk.packages.find((pkg) => pkg.id === draggingId)?.lotLabel}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* ===== Batch release bar ===== */}
      {selected.size > 0 ? (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t bg-foreground px-4 py-2.5 text-background">
          <span className="text-xs tabular-nums">
            {selected.size} {selected.size === 1 ? "home" : "homes"} selected ·{" "}
            {selectedPackages.map((pkg) => pkg.lotLabel).join(", ")}
          </span>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" className="rounded-none text-background hover:bg-background/15 hover:text-background" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
            <Button size="sm" variant="secondary" className="rounded-none" disabled={pending} onClick={beginRelease}>
              Release {selected.size} {selected.size === 1 ? "home" : "homes"}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ===== Detail sheet ===== */}
      <StartPackageSheet
        packageId={sheetId}
        weeks={desk.weeks.map((week) => week.weekStart)}
        currentWeek={desk.currentWeek}
        canWrite={desk.canWrite}
        canRelease={desk.canRelease}
        onOpenChange={(open) => {
          if (open) return
          setSheetId(null)
          // A deep link put the package id in the URL; closing should not leave
          // it there, or a refresh reopens a sheet the user just dismissed.
          if (initialPackageId && scopeBasePath) {
            router.replace(communityId ? `${scopeBasePath}?community=${communityId}` : scopeBasePath)
          }
        }}
        onChanged={refresh}
      />

      {/* ===== Week target editor ===== */}
      <Dialog open={Boolean(slotEditor)} onOpenChange={(open) => { if (!open) setSlotEditor(null) }}>
        <DialogContent className="rounded-none sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{slotEditor?.communityName} — week of {slotEditor ? formatDay(slotEditor.weekStart) : ""}</DialogTitle>
            <DialogDescription>How many houses this community should start that week.</DialogDescription>
          </DialogHeader>
          <form
            id="slot-form"
            className="grid gap-4"
            onSubmit={(event) => { event.preventDefault(); if (!pending) saveSlot() }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="slot-target">Target starts</Label>
              <Input id="slot-target" autoFocus type="number" min={0} max={20} className="rounded-none" value={slotTarget} onChange={(event) => setSlotTarget(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="slot-notes">Note <span className="font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea id="slot-notes" className="rounded-none" rows={2} maxLength={1000} placeholder="Holiday week, model-home push…" value={slotNotes} onChange={(event) => setSlotNotes(event.target.value)} />
            </div>
          </form>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSlotEditor(null)}>Cancel</Button>
            <Button form="slot-form" type="submit" disabled={pending || slotTarget === ""}>{pending ? "Saving…" : "Save target"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Open a package for a lot ===== */}
      <Dialog open={Boolean(openLotId)} onOpenChange={(open) => { if (!open) { setOpenLotId(null); setOpenWeek(null) } }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Open start package</DialogTitle>
            <DialogDescription>
              Creates the preconstruction project this lot needs for plot plans, selections and budget, then opens its readiness gates.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-1">
            <div className="grid gap-1.5">
              <Label>Lot</Label>
              <p className="border px-3 py-2 text-sm">
                {(() => {
                  const candidate = desk.candidates.find((entry) => entry.lotId === openLotId)
                  return candidate ? `${candidate.communityName} · ${candidate.lotLabel}${candidate.planLabel ? ` · ${candidate.planLabel}` : ""}` : "—"
                })()}
              </p>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="open-week">Target start week</Label>
              <Select value={openWeek ?? "none"} onValueChange={(value) => setOpenWeek(value === "none" ? null : value)}>
                <SelectTrigger id="open-week" className="rounded-none"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No target yet — hold in the yard</SelectItem>
                  {desk.weeks.filter((week) => week.weekStart >= desk.currentWeek).map((week) => (
                    <SelectItem key={week.weekStart} value={week.weekStart}>
                      Week of {formatDay(week.weekStart)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between border p-3">
              <div>
                <p className="text-sm font-medium">Financed buyer</p>
                <p className="text-xs text-muted-foreground">Adds the financing/appraisal gate to this package.</p>
              </div>
              <Switch checked={openFinanced} onCheckedChange={setOpenFinanced} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setOpenLotId(null); setOpenWeek(null) }}>Cancel</Button>
            <Button disabled={pending} onClick={openPackage}>{pending ? "Opening…" : "Open package"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Batch release ===== */}
      <Dialog open={releaseOpen} onOpenChange={(open) => { if (!open) { setReleaseOpen(false); setOverSlotIds([]) } }}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Release {selected.size} {selected.size === 1 ? "home" : "homes"}</DialogTitle>
            <DialogDescription>
              Each release generates the budget, schedule, checklists, drawings and PO set from the pinned plan version, then notifies trades.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="batch-release-date">Scheduled start date</Label>
            <Input
              id="batch-release-date"
              type="date"
              className="rounded-none"
              min={new Date().toISOString().slice(0, 10)}
              value={releaseDate}
              onChange={(event) => { setReleaseDate(event.target.value); setOverSlotIds([]) }}
            />
            {releaseDate ? (
              <p className="text-xs text-muted-foreground">Counts against the week of Monday {formatDay(mondayOfIsoWeek(releaseDate))}.</p>
            ) : null}
          </div>
          {overSlotIds.length ? (
            <div className="border border-destructive/50 bg-destructive/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                <AlertTriangle className="h-4 w-4" />
                Over even-flow target
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {overSlotIds.length} of these would push their week past its start target:{" "}
                {overSlotIds.map((id) => desk.packages.find((pkg) => pkg.id === id)?.lotLabel ?? id).join(", ")}.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setReleaseOpen(false); setOverSlotIds([]) }}>Cancel</Button>
            {overSlotIds.length ? (
              <Button variant="destructive" disabled={pending || !releaseDate} onClick={() => submitRelease(true)}>
                {pending ? "Releasing…" : "Release over target"}
              </Button>
            ) : (
              <Button disabled={pending || !releaseDate} onClick={() => submitRelease(false)}>
                {pending ? "Releasing…" : "Release"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The holding pen: everything that wants a slot but does not have one. */
function Yard({ candidates, packages, showCommunity, canWrite, onOpenPackage, onOpenCandidate }: {
  candidates: StartsDesk["candidates"]
  packages: StartPackageListItemDTO[]
  showCommunity: boolean
  canWrite: boolean
  onOpenPackage: (id: string) => void
  onOpenCandidate: (lotId: string) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: YARD_ID, disabled: !canWrite })
  const total = candidates.length + packages.length
  return (
    <aside
      ref={setNodeRef}
      data-dropping={isOver}
      className="lane-yard flex w-60 flex-none flex-col overflow-y-auto"
      aria-label="Homes waiting for a start week"
    >
      <div className="lane-column-head px-2.5 py-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide">The yard</p>
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {total} {total === 1 ? "home" : "homes"} without a week
        </p>
      </div>
      <div className="flex flex-col gap-1.5 p-2">
        {packages.map((pkg) => (
          <StartCard
            key={pkg.id}
            pkg={pkg}
            selected={false}
            selectable={false}
            draggable={canWrite && ["open", "ready"].includes(pkg.status)}
            showCommunity={showCommunity}
            onOpen={onOpenPackage}
            onToggleSelect={() => undefined}
          />
        ))}
        {candidates.map((candidate) => (
          <CandidateCard
            key={candidate.lotId}
            candidate={candidate}
            draggable={canWrite}
            showCommunity={showCommunity}
            onOpen={onOpenCandidate}
          />
        ))}
        {total === 0 ? (
          <p className="px-1 py-6 text-center text-[11px] text-muted-foreground">
            Every home has a target week.
          </p>
        ) : null}
        {canWrite && candidates.length ? (
          <p className="mt-1 flex items-center gap-1 px-1 text-[10px] text-muted-foreground">
            <Plus className="h-3 w-3" />
            Drag a lot into a week to open its package
          </p>
        ) : null}
      </div>
    </aside>
  )
}
