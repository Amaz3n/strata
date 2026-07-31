"use client"

import { useRouter } from "next/navigation"
import { useMemo, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import { setLotPlatPositionsAction } from "@/app/(app)/communities/actions"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUSES, LOT_STATUS_META } from "@/lib/land/lot-lifecycle"
import { resolvePlatLayout, type PlatPosition } from "@/lib/land/plat"
import type { CommunityDetailDTO } from "@/lib/services/communities"
import type { InventoryLotDTO } from "@/lib/services/community-inventory"
import { cn } from "@/lib/utils"

import type { LotMoney } from "./lot-inspector"

type Lens = "status" | "phase" | "takedown" | "premium" | "margin"

const LENSES: Array<{ key: Lens; label: string }> = [
  { key: "status", label: "Status" },
  { key: "phase", label: "Phase" },
  { key: "takedown", label: "Takedown" },
  { key: "premium", label: "Premium" },
  { key: "margin", label: "Margin" },
]

/** Written out rather than interpolated so Tailwind keeps every class. */
const SERIES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const
const PREMIUM_RAMP = ["bg-chart-1/20", "bg-chart-1/40", "bg-chart-1/60", "bg-chart-1/80", "bg-chart-1"] as const
const EMPTY_TONE = "bg-muted-foreground/20"

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

function lotLabel(lot: InventoryLotDTO) {
  return lot.block ? `${lot.block}-${lot.lotNumber}` : lot.lotNumber
}

/**
 * The plat: lots drawn in the shape of the recorded plan. This is the spatial
 * view of the inventory, not the inventory itself — it answers "which lots back
 * the pond" and "is the cul-de-sac sold out". Everything else is a table.
 *
 * Lens, legend, and arrange mode belong to this view and travel with it, so the
 * inventory toolbar above stays the same in both views.
 */
export function LotPlatGrid({
  community,
  lots,
  money: moneyByProject,
  marginTargetPercent,
  selected,
  onToggleSelect,
  onInspect,
  canWrite,
}: {
  community: CommunityDetailDTO
  lots: InventoryLotDTO[]
  money: Record<string, LotMoney>
  /** The community's underwritten margin, when the reader may see money. */
  marginTargetPercent: number | null
  selected: Set<string>
  onToggleSelect: (lotId: string) => void
  onInspect: (lotId: string) => void
  canWrite: boolean
}) {
  const router = useRouter()
  const gridRef = useRef<HTMLDivElement>(null)
  const [isPending, startTransition] = useTransition()
  const [lens, setLens] = useState<Lens>("status")
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

  /**
   * Margin bands come from the community's own underwritten target, not a
   * constant: a builder underwritten at 22% should not see 18% painted green.
   */
  const marginTarget = marginTargetPercent ?? 18

  function toneFor(lot: InventoryLotDTO): string {
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
      case "margin": {
        const entry = lot.projectId ? moneyByProject[lot.projectId] : undefined
        if (!entry) return EMPTY_TONE
        if (entry.projectedMarginPercent < marginTarget - 6) return "bg-destructive"
        if (entry.projectedMarginPercent < marginTarget) return "bg-warning"
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
      case "margin":
        return [
          { label: `Under ${marginTarget - 6}%`, tone: "bg-destructive" },
          { label: `${marginTarget - 6}–${marginTarget}%`, tone: "bg-warning" },
          { label: `${marginTarget}%+`, tone: "bg-success" },
          { label: "No home", tone: EMPTY_TONE },
        ]
      default:
        return LOT_STATUSES.map((status) => ({
          label: LOT_STATUS_META[status].label,
          tone: LOT_STATUS_META[status].barClass,
        }))
    }
  }, [lens, community.phases, community.takedowns, premiumBands, marginTarget])

  function onTileClick(event: React.MouseEvent, lot: InventoryLotDTO) {
    if (arranging) return
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      onToggleSelect(lot.id)
      return
    }
    onInspect(lot.id)
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

  const rows = Math.max(layout.rows, ...[...positions.values()].map((position) => position.y + 1), 1)

  return (
    // A flex child with its own column: without min-h-0/flex-1 here the scroll
    // area below resolves to a zero-height basis and the plat renders blank.
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <div className="flex items-center gap-1.5">
          <span className="microlabel">Color by</span>
          <Select value={lens} onValueChange={(value) => setLens(value as Lens)}>
            <SelectTrigger className="h-7 w-32 rounded-none text-xs" aria-label="Color lots by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LENSES.map((entry) => (
                <SelectItem key={entry.key} value={entry.key}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {legend.map((entry) => (
            <span key={entry.label} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn("size-2 shrink-0", entry.tone)} />
              {entry.label}
            </span>
          ))}
        </div>

        {canWrite ? (
          <div className="ml-auto flex items-center gap-2">
            {arranging ? (
              <>
                <span className="text-[11px] text-muted-foreground">
                  Drag lots into the recorded shape. Dropping on an occupied square swaps them.
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 rounded-none text-xs"
                  onClick={() => {
                    setArranging(false)
                    setDraft(null)
                  }}
                >
                  Cancel
                </Button>
                <Button size="sm" className="h-7 rounded-none text-xs" disabled={isPending} onClick={saveArrangement}>
                  {isPending ? "Saving…" : "Save arrangement"}
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-7 rounded-none text-xs"
                onClick={() => setArranging(true)}
              >
                Arrange plat
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {/* Until somebody drags them, these squares are lot order — not geography.
          Saying so is the difference between a placeholder and a broken map. */}
      {!arranging && layout.unarranged > 0 ? (
        <p className="border-b px-4 py-1.5 text-[11px] text-muted-foreground">
          {layout.unarranged === lots.length
            ? "No plat recorded yet — lots are laid out by phase and number. Arrange plat drags them into the real shape, and every later visit draws it back."
            : `${layout.unarranged} of ${lots.length} lots have not been placed on the plat; they sit below the arranged block.`}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-4">
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
                  lot.buyer?.name ? ` · ${lot.buyer.name}` : lot.projectName ? ` · ${lot.projectName}` : ""
                }`}
                className={cn(
                  "relative z-10 flex flex-col items-center justify-end border pb-0.5 text-[10px] font-medium tabular-nums transition-all",
                  "hover:z-20 hover:border-foreground focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
      </div>
    </div>
  )
}
