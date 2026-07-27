"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { createCommunityAction, createLotTakedownAction } from "@/app/(app)/communities/actions"
import { CommunityStatusBadge } from "@/components/communities/community-status-badge"
import { LotMixBar } from "@/components/communities/lot-mix-bar"
import { Building2, ChevronDown, Plus, Search } from "@/components/icons"
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
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import { LOT_STATUSES, LOT_STATUS_META } from "@/lib/land/lot-lifecycle"
import { lotsAt, type RunwayPoint, type RunwayVerdict } from "@/lib/land/runway"
import type { CommunityLane, CommunityPortfolio } from "@/lib/services/community-portfolio"
import type { DivisionDTO } from "@/lib/services/divisions"
import { cn } from "@/lib/utils"

type Horizon = 6 | 12 | 24
type SortKey = "runway" | "pace" | "margin"

const HORIZONS: Horizon[] = [6, 12, 24]
/** Beyond what the portfolio projected there is nothing to draw, so don't offer it. */
const horizonsWithin = (months: number) => HORIZONS.filter((horizon) => horizon <= months)
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** The order a land manager triages: dying first, finishing last. */
const VERDICT_RANK: Record<RunwayVerdict, number> = {
  dry: 0,
  stalled: 1,
  tight: 2,
  opening: 3,
  holds: 4,
  closing: 5,
}

const VERDICT_TONE: Record<RunwayVerdict, string> = {
  dry: "text-destructive",
  stalled: "text-warning",
  tight: "text-warning",
  opening: "text-muted-foreground",
  holds: "text-success",
  closing: "text-muted-foreground",
}

const URGENCY_TONE = {
  critical: "border-destructive/50 text-destructive hover:bg-destructive/10",
  warning: "border-warning/50 text-warning hover:bg-warning/10",
  neutral: "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
} as const

// Geometry of one band, in viewBox units. The x axis is stretched to the
// column width, so every stroke is drawn with a non-scaling width.
const VB_W = 1000
const SUPPLY_H = 74
const CLOSINGS_H = 20
const PINS_H = 16
const VB_PAD = 8
const VB_H = VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: cents >= 1_000_000 ? "compact" : "standard",
  }).format(cents / 100)
}

function monthLabel(month: string) {
  return MONTH_LABELS[Number(month.slice(5, 7)) - 1] ?? month
}

/** The sentence in the rail. The runway is the fact; everything else supports it. */
function verdictOf(lane: CommunityLane, horizon: number) {
  const dryMonth =
    lane.dryAtMonth != null ? lane.closingsByMonth[Math.min(lane.closingsByMonth.length - 1, Math.floor(lane.dryAtMonth))] : null
  const dryLabel = dryMonth ? `${monthLabel(dryMonth.month)} ’${dryMonth.month.slice(2, 4)}` : null

  switch (lane.verdict) {
    case "dry":
      return {
        lead: "Runs dry",
        key: dryLabel ?? "soon",
        tail: lane.takedowns.length === 0 ? "— no takedown scheduled" : "— before the next takedown lands",
      }
    case "tight":
      return { lead: "Runs dry", key: dryLabel ?? "in range", tail: `— ${Math.round(lane.dryAtMonth ?? 0)} months out` }
    case "stalled":
      return { lead: "No starts in 90 days —", key: `${lane.sellableLots} lots`, tail: "sitting" }
    case "opening":
      return lane.takedowns.length > 0
        ? {
            lead: "Opens with",
            key: `${lane.takedowns[0].lotCount} lots`,
            tail: `at the ${lane.takedowns[0].name} takedown`,
          }
        : { lead: "Not yet platted —", key: "no lots", tail: "and no takedown scheduled" }
    case "closing":
      return { lead: "Closing out —", key: `${lane.sellableLots} left`, tail: `of ${lane.totalLots}, ${lane.lotCounts.closed} closed` }
    default:
      return {
        lead: "Supply",
        key: "holds",
        tail:
          lane.monthsOfSupply != null
            ? `— ${lane.monthsOfSupply.toFixed(0)} months at current starts`
            : `— past ${horizon} months`,
      }
  }
}

function RunwayChart({
  lane,
  horizon,
  scale,
  months,
  scrubT,
  onScrub,
}: {
  lane: CommunityLane
  horizon: Horizon
  scale: number
  months: Array<{ month: string; count: number }>
  scrubT: number | null
  onScrub: (t: number | null) => void
}) {
  const x = (t: number) => (Math.min(t, horizon) / horizon) * VB_W
  const y = (lots: number) => VB_PAD + SUPPLY_H - Math.min(1, lots / scale) * SUPPLY_H

  const clipped = useMemo(() => {
    const points = lane.runway.filter((point) => point.t <= horizon)
    if (lane.runway.at(-1) && (lane.runway.at(-1) as RunwayPoint).t > horizon) {
      points.push({ t: horizon, lots: lotsAt(lane.runway, horizon) })
    }
    return points.length > 0 ? points : [{ t: 0, lots: lane.sellableLots }]
  }, [lane.runway, lane.sellableLots, horizon])

  const line = clipped.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.t).toFixed(1)},${y(point.lots).toFixed(1)}`).join(" ")
  const area = `M0,${VB_PAD + SUPPLY_H} ${clipped
    .map((point) => `L${x(point.t).toFixed(1)},${y(point.lots).toFixed(1)}`)
    .join(" ")} L${x(horizon).toFixed(1)},${VB_PAD + SUPPLY_H} Z`

  const maxClosings = Math.max(1, ...months.map((entry) => entry.count))
  const dryVisible = lane.dryAtMonth != null && lane.dryAtMonth <= horizon && lane.verdict !== "closing"

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      style={{ height: VB_H }}
      className="block w-full cursor-crosshair"
      role="img"
      aria-label={`Lot supply runway for ${lane.name}`}
      onMouseMove={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        onScrub(((event.clientX - bounds.left) / bounds.width) * horizon)
      }}
      onMouseLeave={() => onScrub(null)}
    >
      {months.map((entry, index) => (
        <line
          key={entry.month}
          x1={x(index)}
          y1={0}
          x2={x(index)}
          y2={VB_H}
          stroke="var(--color-border)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}

      <path d={area} fill="var(--color-chart-1)" fillOpacity={0.14} />
      <path
        d={line}
        fill="none"
        stroke="var(--color-chart-1)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {dryVisible ? (
        <>
          <line
            x1={x(lane.dryAtMonth ?? 0)}
            y1={VB_PAD}
            x2={x(lane.dryAtMonth ?? 0)}
            y2={VB_PAD + SUPPLY_H}
            stroke="var(--color-destructive)"
            strokeWidth={1}
            strokeDasharray="2 3"
            vectorEffect="non-scaling-stroke"
          />
          <circle cx={x(lane.dryAtMonth ?? 0)} cy={VB_PAD + SUPPLY_H} r={3.5} fill="var(--color-destructive)" />
        </>
      ) : null}

      {months.map((entry, index) => {
        if (entry.count === 0) return null
        const width = VB_W / horizon - 14
        const left = x(index) + 7
        const height = Math.max(3, (entry.count / maxClosings) * (CLOSINGS_H - 10))
        return (
          <g key={entry.month}>
            <rect
              x={left}
              y={VB_PAD + SUPPLY_H + 10 + (CLOSINGS_H - 10 - height)}
              width={Math.max(2, width)}
              height={height}
              fill="var(--color-chart-1)"
              fillOpacity={index === 0 ? 0.9 : 0.4}
            />
            <text
              x={left + Math.max(2, width) / 2}
              y={VB_PAD + SUPPLY_H + 8}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-muted-foreground)"
            >
              {entry.count}
            </text>
          </g>
        )
      })}

      {lane.takedowns
        .filter((takedown) => takedown.monthOffset <= horizon)
        .map((takedown) => (
          <g key={takedown.id}>
            <path
              d={`M${x(takedown.monthOffset) - 5},${VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H - 3} L${x(takedown.monthOffset)},${
                VB_PAD + SUPPLY_H + CLOSINGS_H + 3
              } L${x(takedown.monthOffset) + 5},${VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H - 3} Z`}
              fill="var(--color-foreground)"
            />
            <text
              x={x(takedown.monthOffset) + 9}
              y={VB_PAD + SUPPLY_H + CLOSINGS_H + PINS_H - 4}
              fontSize={10}
              fill="var(--color-muted-foreground)"
            >
              +{takedown.lotCount} · {takedown.name}
            </text>
          </g>
        ))}

      {scrubT != null ? (
        <line
          x1={x(scrubT)}
          y1={0}
          x2={x(scrubT)}
          y2={VB_H}
          stroke="var(--color-foreground)"
          strokeOpacity={0.5}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  )
}

function Lane({
  lane,
  horizon,
  scale,
  scrubT,
  onScrub,
  expanded,
  onToggle,
  canWrite,
}: {
  lane: CommunityLane
  horizon: Horizon
  scale: number
  scrubT: number | null
  onScrub: (t: number | null) => void
  expanded: boolean
  onToggle: () => void
  canWrite: boolean
}) {
  const months = lane.closingsByMonth.slice(0, horizon)
  const verdict = verdictOf(lane, horizon)
  const paceDelta = lane.requiredPacePerMonth != null ? lane.salesPacePerMonth - lane.requiredPacePerMonth : null

  const scrubbed =
    scrubT != null
      ? {
          lots: Math.round(lotsAt(lane.runway, scrubT)),
          closings: months.slice(0, Math.floor(scrubT) + 1).reduce((sum, entry) => sum + entry.count, 0),
          label: months[Math.min(months.length - 1, Math.floor(scrubT))],
        }
      : null

  return (
    <article className="border-b last:border-b-0">
      <div className="grid lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex flex-col gap-1.5 border-b p-3 lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${lane.name}`}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown className={cn("size-3.5 transition-transform", !expanded && "-rotate-90")} />
            </button>
            <Link href={`/communities/${lane.id}`} className="truncate text-sm font-medium hover:underline">
              {lane.name}
            </Link>
            {lane.code ? <span className="shrink-0 text-[10px] tracking-wide text-muted-foreground">{lane.code}</span> : null}
            <CommunityStatusBadge status={lane.status} />
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {[lane.market, lane.divisionName].filter(Boolean).join(" · ") || "No market set"}
          </p>

          {scrubbed ? (
            <p className="text-xs tabular-nums text-muted-foreground">
              <span className="text-sm font-medium text-foreground">{scrubbed.lots}</span> sellable ·{" "}
              <span className="text-foreground">{scrubbed.closings}</span> closed by{" "}
              {scrubbed.label ? monthLabel(scrubbed.label.month) : "then"}
            </p>
          ) : (
            <p className="text-xs leading-snug text-muted-foreground">
              {verdict.lead} <span className={cn("font-medium", VERDICT_TONE[lane.verdict])}>{verdict.key}</span>{" "}
              {verdict.tail}
            </p>
          )}

          <dl className="mt-auto flex items-end gap-4 pt-1.5">
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Pace</dt>
              <dd
                className={cn(
                  "text-xs tabular-nums",
                  paceDelta != null && paceDelta < -0.2 && "text-destructive",
                  paceDelta != null && paceDelta > 0.1 && "text-success",
                )}
              >
                {lane.salesPacePerMonth.toFixed(1)}
                {lane.requiredPacePerMonth != null ? (
                  <span className="text-muted-foreground"> / {lane.requiredPacePerMonth.toFixed(1)}</span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Sellable</dt>
              <dd className="text-xs tabular-nums">{lane.sellableLots}</dd>
            </div>
            {lane.marginPercent != null ? (
              <div>
                <dt className="text-[9px] uppercase tracking-wider text-muted-foreground">Margin</dt>
                <dd
                  className={cn(
                    "text-xs tabular-nums",
                    lane.targetMarginPercent != null && lane.marginPercent < lane.targetMarginPercent && "text-destructive",
                  )}
                >
                  {lane.marginPercent.toFixed(1)}%
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        <div className="min-w-0">
          <RunwayChart
            lane={lane}
            horizon={horizon}
            scale={scale}
            months={months}
            scrubT={scrubT}
            onScrub={onScrub}
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2 pt-0.5">
            {lane.urgencies.length > 0 ? (
              lane.urgencies.map((urgency) => (
                <Link
                  key={urgency.kind}
                  href={urgency.href}
                  className={cn("border px-1.5 py-0.5 text-[11px] font-medium transition-colors", URGENCY_TONE[urgency.tone])}
                >
                  {urgency.label}
                </Link>
              ))
            ) : (
              <span className="text-[11px] text-muted-foreground/60">Nothing due</span>
            )}
          </div>
        </div>
      </div>

      {expanded ? <LaneDetail lane={lane} canWrite={canWrite} /> : null}
    </article>
  )
}

function LaneDetail({ lane, canWrite }: { lane: CommunityLane; canWrite: boolean }) {
  const totalCash = lane.takedowns.reduce((sum, takedown) => sum + takedown.cashCents, 0)
  const totalDeposits = lane.takedowns.reduce((sum, takedown) => sum + takedown.depositCents, 0)

  return (
    <div className="grid border-t bg-muted/25 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="p-3 lg:border-r">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">Takedown schedule</h3>
          {canWrite ? <ScheduleTakedownDialog lane={lane} /> : null}
        </div>
        {lane.takedowns.length > 0 ? (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="border-b text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1 text-left font-normal">Takedown</th>
                <th className="py-1 text-left font-normal">Date</th>
                <th className="py-1 text-right font-normal">Lots</th>
                <th className="py-1 text-right font-normal">Cash</th>
                <th className="py-1 text-right font-normal">Deposit</th>
              </tr>
            </thead>
            <tbody>
              {lane.takedowns.map((takedown) => (
                <tr key={takedown.id} className="border-b last:border-b-0">
                  <td className="py-1.5">{takedown.name}</td>
                  <td className="py-1.5 tabular-nums text-muted-foreground">{takedown.scheduledDate}</td>
                  <td className="py-1.5 text-right tabular-nums">{takedown.lotCount}</td>
                  <td className="py-1.5 text-right tabular-nums">{takedown.cashCents > 0 ? money(takedown.cashCents) : "—"}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                    {takedown.depositCents > 0 ? money(takedown.depositCents) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-[11px] text-muted-foreground">
                <td className="pt-1.5" colSpan={3}>
                  Committed over the horizon
                </td>
                <td className="pt-1.5 text-right tabular-nums text-foreground">{money(totalCash)}</td>
                <td className="pt-1.5 text-right tabular-nums">{money(totalDeposits)}</td>
              </tr>
            </tfoot>
          </table>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            No takedowns scheduled.{" "}
            {lane.dryAtMonth != null
              ? "This community runs out of sellable lots inside the horizon."
              : "Supply is whatever is already platted."}
          </p>
        )}
      </div>

      <div className="border-t p-3 lg:border-t-0">
        <h3 className="text-[10px] uppercase tracking-wider text-muted-foreground">Lot mix</h3>
        <LotMixBar counts={lane.lotCounts} plannedLotCount={lane.plannedLotCount} className="mt-2 w-full" />
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          {LOT_STATUSES.map((status) => (
            <div key={status} className="flex items-center justify-between gap-2">
              <dt className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                <span className={cn("size-2 shrink-0", LOT_STATUS_META[status].barClass)} />
                <span className="truncate">{LOT_STATUS_META[status].label}</span>
              </dt>
              <dd className="tabular-nums">{lane.lotCounts[status]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2.5 text-[11px] text-muted-foreground">
          {lane.startsLast90} started in the last 90 days ·{" "}
          {lane.monthsOfSupply != null ? `${lane.monthsOfSupply.toFixed(1)} months of supply` : "no start rate to measure against"}
        </p>
        <Button asChild size="sm" variant="outline" className="mt-2.5 w-full rounded-none">
          <Link href={`/communities/${lane.id}`}>Open the plat</Link>
        </Button>
      </div>
    </div>
  )
}

function ScheduleTakedownDialog({ lane }: { lane: CommunityLane }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [scheduledDate, setScheduledDate] = useState("")
  const [lotCount, setLotCount] = useState("")
  const [pricePerLot, setPricePerLot] = useState("")

  function submit() {
    startTransition(async () => {
      try {
        unwrapAction(
          await createLotTakedownAction(lane.id, {
            name: name.trim(),
            scheduledDate,
            lotCount: Number(lotCount),
            pricePerLotCents: pricePerLot ? Math.round(Number(pricePerLot) * 100) : null,
          }),
        )
        toast.success("Takedown scheduled")
        setOpen(false)
        setName("")
        setScheduledDate("")
        setLotCount("")
        setPricePerLot("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to schedule takedown", { description: (error as Error).message })
      }
    })
  }

  const valid = name.trim().length > 0 && scheduledDate.length > 0 && Number(lotCount) > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-6 rounded-none px-2 text-[11px]">
          <Plus className="mr-1 size-3" />
          Schedule takedown
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Schedule a takedown</DialogTitle>
          <DialogDescription>Adding lots to {lane.name} pushes its runway out by the lot count.</DialogDescription>
        </DialogHeader>
        <form
          id="schedule-takedown"
          onSubmit={(event) => {
            event.preventDefault()
            if (valid && !isPending) submit()
          }}
          className="grid gap-4 py-2"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="takedown-name">Name</Label>
            <Input id="takedown-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Phase 3" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="takedown-date">Scheduled date</Label>
              <Input id="takedown-date" type="date" value={scheduledDate} onChange={(event) => setScheduledDate(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="takedown-lots">Lots</Label>
              <Input
                id="takedown-lots"
                type="number"
                min={1}
                value={lotCount}
                onChange={(event) => setLotCount(event.target.value)}
                placeholder="24"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="takedown-price">
              Price per lot <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="takedown-price"
              type="number"
              min={0}
              value={pricePerLot}
              onChange={(event) => setPricePerLot(event.target.value)}
              placeholder="72000"
            />
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button form="schedule-takedown" type="submit" disabled={!valid || isPending}>
            {isPending ? "Scheduling…" : "Schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function CommunityBoard({
  portfolio,
  divisions,
  canWrite,
  status,
}: {
  portfolio: CommunityPortfolio
  divisions: DivisionDTO[]
  canWrite: boolean
  status?: string
}) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [horizon, setHorizon] = useState<Horizon>(12)
  const [sort, setSort] = useState<SortKey>("runway")
  const [scrubT, setScrubT] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [selectedDivision, setSelectedDivision] = useState("none")

  const activeDivisions = useMemo(() => divisions.filter((division) => !division.archived), [divisions])

  const lanes = useMemo(() => {
    const query = search.trim().toLowerCase()
    const filtered = query
      ? portfolio.lanes.filter((lane) =>
          [lane.name, lane.code, lane.market, lane.divisionName].some((field) => field?.toLowerCase().includes(query)),
        )
      : portfolio.lanes
    return [...filtered].sort((a, b) => {
      if (sort === "pace") {
        const delta = (lane: CommunityLane) =>
          lane.requiredPacePerMonth != null ? lane.salesPacePerMonth - lane.requiredPacePerMonth : Number.POSITIVE_INFINITY
        return delta(a) - delta(b)
      }
      if (sort === "margin") {
        return (a.marginPercent ?? Number.POSITIVE_INFINITY) - (b.marginPercent ?? Number.POSITIVE_INFINITY)
      }
      const rank = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]
      if (rank !== 0) return rank
      return (a.dryAtMonth ?? Number.POSITIVE_INFINITY) - (b.dryAtMonth ?? Number.POSITIVE_INFINITY)
    })
  }, [portfolio.lanes, search, sort])

  // Every band shares one vertical scale — comparing the shapes by eye is the
  // entire point of stacking them on one axis.
  const scale = useMemo(
    () => Math.max(1, ...lanes.flatMap((lane) => lane.runway.filter((point) => point.t <= horizon).map((point) => point.lots))),
    [lanes, horizon],
  )

  const months = portfolio.lanes[0]?.closingsByMonth.slice(0, horizon) ?? []

  function updateStatus(value: string) {
    const params = new URLSearchParams()
    if (value && value !== "all") params.set("status", value)
    router.push(params.size ? `/communities?${params}` : "/communities")
  }

  function submit() {
    startTransition(async () => {
      try {
        const created = unwrapAction(
          await createCommunityAction({
            name,
            code: code || null,
            divisionId: selectedDivision === "none" ? null : selectedDivision,
            status: "active",
          }),
        )
        toast.success("Community created")
        setOpen(false)
        setName("")
        setCode("")
        router.push(`/communities/${created.id}`)
      } catch (error) {
        toast.error("Unable to create community", { description: (error as Error).message })
      }
    })
  }

  const createDialog = canWrite ? (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="rounded-none">
          <Plus className="mr-1.5 h-4 w-4" />
          New community
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New community</DialogTitle>
          <DialogDescription>Create the land container before adding phases and lots.</DialogDescription>
        </DialogHeader>
        <form
          id="create-community"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() && !isPending) submit()
          }}
          className="grid gap-4 py-2"
        >
          <div className="grid gap-1.5">
            <Label htmlFor="community-name">Name</Label>
            <Input
              id="community-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Cypress Creek"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="community-code">
              Code <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="community-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={12}
              placeholder="CYP"
            />
          </div>
          {activeDivisions.length > 0 ? (
            <div className="grid gap-1.5">
              <Label>Division</Label>
              <Select value={selectedDivision} onValueChange={setSelectedDivision}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Main</SelectItem>
                  {activeDivisions.map((division) => (
                    <SelectItem key={division.id} value={division.id}>
                      {division.name}
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
          <Button form="create-community" type="submit" disabled={!name.trim() || isPending}>
            {isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  if (portfolio.lanes.length === 0 && !status) {
    return (
      <div className="flex min-h-full flex-col p-4">
        <Empty className="flex-1 rounded-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-none">
              <Building2 />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No communities yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              A community holds your phases, takedowns, and the lots that become production starts. Create one to begin
              tracking land through closing.
            </EmptyDescription>
          </EmptyHeader>
          {canWrite ? <EmptyContent>{createDialog}</EmptyContent> : null}
        </Empty>
      </div>
    )
  }

  const { totals } = portfolio

  return (
    <div className="flex min-h-full flex-col" onMouseLeave={() => setScrubT(null)}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-8 w-52 rounded-none pl-8 text-xs"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search communities"
              aria-label="Search communities"
            />
          </div>
          <Select value={status ?? "all"} onValueChange={updateStatus}>
            <SelectTrigger className="h-8 w-32 rounded-none text-xs">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="planning">Planning</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="sold_out">Sold out</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex border" role="group" aria-label="Horizon">
            {horizonsWithin(portfolio.horizonMonths).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={horizon === value}
                onClick={() => setHorizon(value)}
                className={cn(
                  "h-8 border-l px-2.5 text-[11px] transition-colors first:border-l-0",
                  horizon === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {value} mo
              </button>
            ))}
          </div>
          <div className="flex border" role="group" aria-label="Sort">
            {(["runway", "pace", "margin"] as SortKey[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                onClick={() => setSort(value)}
                className={cn(
                  "h-8 border-l px-2.5 text-[11px] capitalize transition-colors first:border-l-0",
                  sort === value ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
                )}
              >
                {value}
              </button>
            ))}
          </div>
          {createDialog}
        </div>
      </div>

      <p className="border-b px-4 py-2.5 text-xs text-muted-foreground">
        <span className="tabular-nums text-foreground">{totals.communities}</span>{" "}
        {totals.communities === 1 ? "community" : "communities"} ·{" "}
        <span className="tabular-nums text-foreground">{totals.sellableLots}</span> of{" "}
        <span className="tabular-nums text-foreground">{totals.totalLots}</span> lots sellable ·{" "}
        <span className="tabular-nums text-foreground">{totals.closingsThisMonth}</span> closings this month
        {totals.takedownCashCents > 0 ? (
          <>
            {" · "}
            <span className="tabular-nums text-foreground">{money(totals.takedownCashCents)}</span> committed to takedowns
          </>
        ) : null}
        {totals.runningDry > 0 ? (
          <>
            {" · "}
            <span className="font-medium text-destructive tabular-nums">{totals.runningDry} running dry</span>
          </>
        ) : null}
      </p>

      {lanes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No matching communities</p>
          <p className="max-w-md text-xs text-muted-foreground">Nothing matches the current search and filters.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 rounded-none"
            onClick={() => {
              setSearch("")
              router.push("/communities")
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <>
          <div className="sticky top-0 z-10 grid border-b bg-background lg:grid-cols-[300px_minmax(0,1fr)]">
            <div className="hidden px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground lg:block lg:border-r">
              Community · runway
            </div>
            <div className="hidden lg:grid" style={{ gridTemplateColumns: `repeat(${horizon}, minmax(0, 1fr))` }}>
              {months.map((entry, index) => (
                <div
                  key={entry.month}
                  className={cn(
                    "truncate border-l py-1.5 pl-1.5 text-[10px] uppercase tracking-wider",
                    index % 3 === 0 ? "text-muted-foreground" : "text-muted-foreground/50",
                  )}
                >
                  {monthLabel(entry.month)}
                  {index % 3 === 0 ? ` ’${entry.month.slice(2, 4)}` : ""}
                </div>
              ))}
            </div>
          </div>
          {lanes.map((lane) => (
            <Lane
              key={lane.id}
              lane={lane}
              horizon={horizon}
              scale={scale}
              scrubT={scrubT}
              onScrub={setScrubT}
              expanded={expandedId === lane.id}
              onToggle={() => setExpandedId(expandedId === lane.id ? null : lane.id)}
              canWrite={canWrite}
            />
          ))}
        </>
      )}
    </div>
  )
}
