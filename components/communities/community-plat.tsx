"use client"

import { useRouter } from "next/navigation"
import { useMemo, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  bulkUpdateLotsAction,
  createLotRangeAction,
  setLotPlatPositionsAction,
} from "@/app/(app)/communities/actions"
import { LotInspector, type LotMoney } from "@/components/communities/lot-inspector"
import { Plus, Search } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUSES, LOT_STATUS_META, type LotStatus } from "@/lib/land/lot-lifecycle"
import { resolvePlatLayout, type PlatPosition } from "@/lib/land/plat"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { PlatLotDTO } from "@/lib/services/lots"
import { cn } from "@/lib/utils"

type Lens = "status" | "phase" | "takedown" | "premium" | "home" | "margin"

const LENSES: Array<{ key: Lens; label: string }> = [
  { key: "status", label: "Status" },
  { key: "phase", label: "Phase" },
  { key: "takedown", label: "Takedown" },
  { key: "premium", label: "Premium" },
  { key: "home", label: "Home" },
  { key: "margin", label: "Margin" },
]

/** Written out rather than interpolated so Tailwind keeps every class. */
const SERIES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const
const PREMIUM_RAMP = ["bg-chart-1/20", "bg-chart-1/40", "bg-chart-1/60", "bg-chart-1/80", "bg-chart-1"] as const
const EMPTY_TONE = "bg-muted-foreground/20"

const NONE = "none"
const CELL = 34
const GAP = 4
const STRIDE = CELL + GAP

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: cents >= 1_000_000 ? "compact" : "standard",
  }).format(cents / 100)
}

function lotLabel(lot: PlatLotDTO) {
  return lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber
}

export function CommunityPlat({
  community,
  lots,
  total,
  truncated,
  money: moneyByProject,
  projects,
  canWrite,
}: {
  community: CommunityDetailDTO
  lots: PlatLotDTO[]
  total: number
  truncated: boolean
  money: Record<string, LotMoney>
  projects: Array<{ id: string; name: string }>
  canWrite: boolean
}) {
  const router = useRouter()
  const gridRef = useRef<HTMLDivElement>(null)
  const [isPending, startTransition] = useTransition()
  const [lens, setLens] = useState<Lens>("status")
  const [search, setSearch] = useState("")
  const [phaseFilter, setPhaseFilter] = useState(NONE)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const [draft, setDraft] = useState<Map<string, PlatPosition> | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  const phaseIndex = useMemo(
    () => new Map(community.phases.map((phase, index) => [phase.id, index])),
    [community.phases],
  )
  const takedownIndex = useMemo(
    () => new Map(community.takedowns.map((takedown, index) => [takedown.id, index])),
    [community.takedowns],
  )

  const layout = useMemo(() => resolvePlatLayout(lots), [lots])
  const positions = draft ?? layout.positions

  const premiumBands = useMemo(() => {
    const values = lots.map((lot) => lot.premiumCents).filter((value) => value > 0).sort((a, b) => a - b)
    if (values.length === 0) return []
    return [0.2, 0.4, 0.6, 0.8].map((quantile) => values[Math.floor(quantile * (values.length - 1))])
  }, [lots])

  function toneFor(lot: PlatLotDTO): string {
    switch (lens) {
      case "phase": {
        const index = lot.phaseId != null ? phaseIndex.get(lot.phaseId) : undefined
        return index == null ? EMPTY_TONE : SERIES[index % SERIES.length]
      }
      case "takedown": {
        const index = lot.takedownId != null ? takedownIndex.get(lot.takedownId) : undefined
        return index == null ? EMPTY_TONE : SERIES[index % SERIES.length]
      }
      case "premium": {
        if (lot.premiumCents <= 0 || premiumBands.length === 0) return EMPTY_TONE
        const band = premiumBands.filter((edge) => lot.premiumCents > edge).length
        return PREMIUM_RAMP[Math.min(band, PREMIUM_RAMP.length - 1)]
      }
      case "home":
        return lot.projectId ? "bg-chart-1" : EMPTY_TONE
      case "margin": {
        const entry = lot.projectId ? moneyByProject[lot.projectId] : undefined
        if (!entry) return EMPTY_TONE
        if (entry.projectedMarginPercent < 12) return "bg-destructive"
        if (entry.projectedMarginPercent < 18) return "bg-warning"
        return "bg-success"
      }
      default:
        return LOT_STATUS_META[lot.status].barClass
    }
  }

  const legend = useMemo((): Array<{ label: string; tone: string }> => {
    switch (lens) {
      case "phase":
        return [
          ...community.phases.map((phase, index) => ({ label: phase.name, tone: SERIES[index % SERIES.length] })),
          { label: "Unphased", tone: EMPTY_TONE },
        ]
      case "takedown":
        return [
          ...community.takedowns.map((takedown, index) => ({
            label: takedown.name,
            tone: SERIES[index % SERIES.length],
          })),
          { label: "Unassigned", tone: EMPTY_TONE },
        ]
      case "premium":
        return [
          { label: "No premium", tone: EMPTY_TONE },
          ...PREMIUM_RAMP.map((tone, index) => ({
            label: premiumBands[index - 1] != null ? `${money(premiumBands[index - 1])}+` : "Lowest",
            tone,
          })),
        ]
      case "home":
        return [
          { label: "Home attached", tone: "bg-chart-1" },
          { label: "No home", tone: EMPTY_TONE },
        ]
      case "margin":
        return [
          { label: "Under 12%", tone: "bg-destructive" },
          { label: "12–18%", tone: "bg-warning" },
          { label: "18%+", tone: "bg-success" },
          { label: "No home", tone: EMPTY_TONE },
        ]
      default:
        return LOT_STATUSES.map((status) => ({
          label: LOT_STATUS_META[status].label,
          tone: LOT_STATUS_META[status].barClass,
        }))
    }
  }, [lens, community.phases, community.takedowns, premiumBands])

  const query = search.trim().toLowerCase()
  function isDimmed(lot: PlatLotDTO) {
    if (phaseFilter !== NONE && lot.phaseId !== phaseFilter) return true
    if (!query) return false
    return !(
      lotLabel(lot).toLowerCase().includes(query) ||
      lot.address?.toLowerCase().includes(query) ||
      lot.projectName?.toLowerCase().includes(query) ||
      lot.planName?.toLowerCase().includes(query)
    )
  }

  function onTileClick(event: React.MouseEvent, lot: PlatLotDTO) {
    if (arranging) return
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      setSelected((current) => {
        const next = new Set(current)
        if (next.has(lot.id)) next.delete(lot.id)
        else next.add(lot.id)
        return next
      })
      setInspecting(null)
      return
    }
    setSelected(new Set())
    setInspecting(lot.id)
  }

  function cellFromPointer(event: React.DragEvent) {
    const bounds = gridRef.current?.getBoundingClientRect()
    if (!bounds) return null
    const x = Math.max(0, Math.floor((event.clientX - bounds.left) / STRIDE))
    const y = Math.max(0, Math.floor((event.clientY - bounds.top) / STRIDE))
    return { x, y }
  }

  function drop(event: React.DragEvent) {
    event.preventDefault()
    if (!arranging || !dragging) return
    const cell = cellFromPointer(event)
    if (!cell) return
    setDraft((current) => {
      const next = new Map(current ?? layout.positions)
      const occupant = [...next.entries()].find(
        ([id, position]) => id !== dragging && position.x === cell.x && position.y === cell.y,
      )
      const from = next.get(dragging)
      // Dropping onto a taken cell swaps the two lots, so an arrangement can be
      // corrected without first clearing a space.
      if (occupant && from) next.set(occupant[0], from)
      next.set(dragging, cell)
      return next
    })
    setDragging(null)
  }

  function saveArrangement() {
    const source = draft ?? layout.positions
    startTransition(async () => {
      try {
        unwrapAction(
          await setLotPlatPositionsAction(
            community.id,
            lots
              .filter((lot) => source.has(lot.id))
              .map((lot) => ({
                lotId: lot.id,
                platX: (source.get(lot.id) as PlatPosition).x,
                platY: (source.get(lot.id) as PlatPosition).y,
              })),
          ),
        )
        toast.success("Plat arrangement saved")
        setArranging(false)
        setDraft(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to save the plat", { description: (error as Error).message })
      }
    })
  }

  function bulkPatch(patch: Record<string, unknown>, success: string) {
    startTransition(async () => {
      try {
        unwrapAction(await bulkUpdateLotsAction(community.id, { lotIds: [...selected], patch }))
        toast.success(success)
        setSelected(new Set())
        router.refresh()
      } catch (error) {
        toast.error("Unable to update the lots", { description: (error as Error).message })
      }
    })
  }

  const inspectedLot = lots.find((lot) => lot.id === inspecting) ?? null
  const rows = Math.max(layout.rows, ...[...positions.values()].map((position) => position.y + 1), 1)

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex border" role="group" aria-label="Colour lots by">
            {LENSES.map((entry) => (
              <button
                key={entry.key}
                type="button"
                aria-pressed={lens === entry.key}
                onClick={() => setLens(entry.key)}
                className={cn(
                  "h-8 border-l px-2.5 text-[11px] transition-colors first:border-l-0",
                  lens === entry.key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-8 w-44 rounded-none pl-8 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a lot"
              aria-label="Find a lot"
            />
          </div>
          {community.phases.length > 0 ? (
            <Select value={phaseFilter} onValueChange={setPhaseFilter}>
              <SelectTrigger className="h-8 w-32 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>All phases</SelectItem>
                {community.phases.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>
                    {phase.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>

        {canWrite ? (
          <div className="flex items-center gap-2">
            {arranging ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 rounded-none text-xs"
                  onClick={() => {
                    setArranging(false)
                    setDraft(null)
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" className="h-8 rounded-none text-xs" disabled={isPending} onClick={saveArrangement}>
                  {isPending ? "Saving…" : "Save arrangement"}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-none text-xs"
                onClick={() => {
                  setArranging(true)
                  setSelected(new Set())
                  setInspecting(null)
                }}
              >
                Arrange plat
              </Button>
            )}
            <AddLotsDialog community={community} />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-4 py-1.5">
        {legend.map((entry) => (
          <span key={entry.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("size-2 shrink-0", entry.tone)} />
            {entry.label}
          </span>
        ))}
        <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
          {total} {total === 1 ? "lot" : "lots"}
          {layout.unarranged > 0 && !arranging ? ` · ${layout.unarranged} not arranged` : ""}
        </span>
      </div>

      {arranging ? (
        <p className="border-b bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
          Drag lots into the shape of the recorded plat. Dropping onto an occupied square swaps the two lots.
        </p>
      ) : null}

      {lots.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-24 text-center">
          <p className="text-sm font-medium">No lots platted yet</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Add a numbered range and they appear here as a plat you can colour, arrange, and work.
          </p>
          {canWrite ? <AddLotsDialog community={community} /> : null}
        </div>
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div
            ref={gridRef}
            onDragOver={(event) => {
              if (arranging) event.preventDefault()
            }}
            onDrop={drop}
            className="relative grid w-fit"
            style={{
              gridTemplateColumns: `repeat(${layout.columns}, ${CELL}px)`,
              gridAutoRows: `${CELL}px`,
              gap: `${GAP}px`,
            }}
          >
            {arranging
              ? Array.from({ length: layout.columns * (rows + 1) }, (_, index) => (
                  <div
                    key={`cell-${index}`}
                    aria-hidden="true"
                    className="border border-dashed border-border/60"
                    style={{
                      gridColumnStart: (index % layout.columns) + 1,
                      gridRowStart: Math.floor(index / layout.columns) + 1,
                    }}
                  />
                ))
              : null}

            {lots.map((lot) => {
              const position = positions.get(lot.id)
              if (!position) return null
              const dimmed = !arranging && isDimmed(lot)
              const isSelected = selected.has(lot.id)
              return (
                <button
                  key={lot.id}
                  type="button"
                  draggable={arranging}
                  onDragStart={() => setDragging(lot.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={(event) => onTileClick(event, lot)}
                  aria-label={`Lot ${lotLabel(lot)}, ${LOT_STATUS_META[lot.status].label.toLowerCase()}`}
                  aria-pressed={isSelected}
                  title={`Lot ${lotLabel(lot)} · ${LOT_STATUS_META[lot.status].label}${
                    lot.projectName ? ` · ${lot.projectName}` : ""
                  }`}
                  className={cn(
                    "relative z-10 flex flex-col items-center justify-end border pb-0.5 text-[10px] font-medium tabular-nums transition-all",
                    "hover:z-20 hover:border-foreground focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    dimmed ? "opacity-20" : "opacity-100",
                    isSelected ? "border-foreground ring-1 ring-foreground" : "border-border",
                    arranging ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    dragging === lot.id && "opacity-40",
                  )}
                  style={{ gridColumnStart: position.x + 1, gridRowStart: position.y + 1 }}
                >
                  <span className={cn("absolute inset-x-0 top-0 h-1.5", toneFor(lot))} />
                  {lot.lotNumber}
                </button>
              )
            })}
          </div>

          {truncated ? (
            <p className="mt-4 text-xs text-muted-foreground">
              Showing {lots.length} of {total} lots. Narrow by phase to reach the rest.
            </p>
          ) : null}
        </div>
      )}

      {selected.size > 0 ? (
        <div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-2 border-t bg-background px-4 py-2">
          <span className="text-xs tabular-nums">
            {selected.size} {selected.size === 1 ? "lot" : "lots"} selected
          </span>
          <Select
            value=""
            disabled={isPending}
            onValueChange={(value) => bulkPatch({ status: value }, `${selected.size} lots updated`)}
          >
            <SelectTrigger className="h-7 w-32 rounded-none text-xs">
              <SelectValue placeholder="Set status" />
            </SelectTrigger>
            <SelectContent>
              {LOT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {LOT_STATUS_META[status].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {community.phases.length > 0 ? (
            <Select
              value=""
              disabled={isPending}
              onValueChange={(value) =>
                bulkPatch({ phaseId: value === NONE ? null : value }, `${selected.size} lots rephased`)
              }
            >
              <SelectTrigger className="h-7 w-32 rounded-none text-xs">
                <SelectValue placeholder="Set phase" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unphased</SelectItem>
                {community.phases.map((phase) => (
                  <SelectItem key={phase.id} value={phase.id}>
                    {phase.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {community.takedowns.length > 0 ? (
            <Select
              value=""
              disabled={isPending}
              onValueChange={(value) =>
                bulkPatch({ takedownId: value === NONE ? null : value }, `${selected.size} lots reassigned`)
              }
            >
              <SelectTrigger className="h-7 w-36 rounded-none text-xs">
                <SelectValue placeholder="Set takedown" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Unassigned</SelectItem>
                {community.takedowns.map((takedown) => (
                  <SelectItem key={takedown.id} value={takedown.id}>
                    {takedown.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 rounded-none text-xs"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <LotInspector
        lot={inspectedLot}
        community={community}
        money={inspectedLot?.projectId ? moneyByProject[inspectedLot.projectId] ?? null : null}
        projects={projects}
        canWrite={canWrite}
        onOpenChange={(open) => {
          if (!open) setInspecting(null)
        }}
      />
    </div>
  )
}

function AddLotsDialog({ community }: { community: CommunityDetailDTO }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [prefix, setPrefix] = useState("")
  const [fromNumber, setFromNumber] = useState("")
  const [toNumber, setToNumber] = useState("")
  const [phaseId, setPhaseId] = useState(NONE)

  const count = Number(toNumber) - Number(fromNumber) + 1
  const valid = Number.isFinite(count) && count > 0 && count <= 500 && fromNumber !== "" && toNumber !== ""

  function submit() {
    startTransition(async () => {
      try {
        unwrapAction(
          await createLotRangeAction(community.id, {
            fromNumber: Number(fromNumber),
            toNumber: Number(toNumber),
            prefix: prefix.trim() || undefined,
            phaseId: phaseId === NONE ? null : phaseId,
          }),
        )
        toast.success(`${count} lots added`)
        setOpen(false)
        setFromNumber("")
        setToNumber("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to add lots", { description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8 rounded-none text-xs">
          <Plus className="mr-1.5 size-3.5" />
          Add lots
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add lots</DialogTitle>
          <DialogDescription>
            Create a numbered range of up to 500 lots. They land at the bottom of the plat, ready to arrange.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-lots"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !isPending) submit()
          }}
          className="grid gap-4 py-2"
        >
          <div className="grid grid-cols-3 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="lot-prefix">
                Prefix <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input id="lot-prefix" value={prefix} onChange={(event) => setPrefix(event.target.value)} placeholder="A-" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-from">From</Label>
              <Input
                id="lot-from"
                type="number"
                min={0}
                autoFocus
                value={fromNumber}
                onChange={(event) => setFromNumber(event.target.value)}
                placeholder="1"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lot-to">To</Label>
              <Input
                id="lot-to"
                type="number"
                min={0}
                value={toNumber}
                onChange={(event) => setToNumber(event.target.value)}
                placeholder="48"
              />
            </div>
          </div>
          {community.phases.length > 0 ? (
            <div className="grid gap-1.5">
              <Label>Phase</Label>
              <Select value={phaseId} onValueChange={setPhaseId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Unphased</SelectItem>
                  {community.phases.map((phase) => (
                    <SelectItem key={phase.id} value={phase.id}>
                      {phase.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button form="add-lots" type="submit" disabled={!valid || isPending}>
            {isPending ? "Adding…" : valid ? `Add ${count} lots` : "Add lots"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
