"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { Fragment, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { bulkRepriceCommunityPlansAction, setCommunityPlanPriceAction } from "@/app/(app)/sales/actions"
import { Plan3dDialog } from "@/components/plans/plan-3d-dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import { MARGIN_BAND_META, THIN_MARGIN_PCT, grossMarginPct, marginBand } from "@/lib/plans/margin"
import { offeringPrice, type OfferingIncentive } from "@/lib/sales/offering"
import { cn } from "@/lib/utils"

export interface OfferingPlanRow {
  key: string
  availabilityId: string
  planId: string
  planCode: string | null
  planName: string
  elevationName: string
  beds: number | null
  baths: number | null
  sqft: number | null
  stories: number | null
  garageBays: number | null
  basePriceCents: number
  /** When this plan was last repriced in this community, and from what. */
  repricedAt: string | null
  previousBasePriceCents: number | null
  /** Velocity: what has closed, and what is under construction or sold. */
  soldCount: number
  buildingCount: number
}

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

function shortMoney(cents: number) {
  const dollars = Math.round(cents / 100)
  return dollars >= 1_000_000 ? `$${(dollars / 1_000_000).toFixed(2)}M` : `$${Math.round(dollars / 1000)}k`
}

/** Dates a builder says out loud, not the ISO strings the table used to print. */
function readableDate(value: string | null) {
  if (!value) return null
  const date = new Date(value.length <= 10 ? `${value}T00:00:00Z` : value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

/** One plan and every elevation of it that this community sells. */
type PlanGroup = {
  planId: string
  planCode: string | null
  planName: string
  beds: number | null
  baths: number | null
  sqft: number | null
  stories: number | null
  garageBays: number | null
  soldCount: number
  buildingCount: number
  rows: OfferingPlanRow[]
}

function groupByPlan(rows: OfferingPlanRow[]): PlanGroup[] {
  const groups = new Map<string, PlanGroup>()
  for (const row of rows) {
    const group = groups.get(row.planId) ?? {
      planId: row.planId,
      planCode: row.planCode,
      planName: row.planName,
      beds: row.beds,
      baths: row.baths,
      sqft: row.sqft,
      stories: row.stories,
      garageBays: row.garageBays,
      // Velocity is counted off the lot's plan, so it belongs to the plan and
      // not to each of its elevations — printing it per row made a plan that
      // sold six houses look like it sold eighteen.
      soldCount: row.soldCount,
      buildingCount: row.buildingCount,
      rows: [],
    }
    group.rows.push(row)
    groups.set(row.planId, group)
  }
  for (const group of groups.values()) {
    group.rows.sort((a, b) => a.basePriceCents - b.basePriceCents)
  }
  // A price sheet reads cheapest first — that is the ladder a buyer walks up.
  return [...groups.values()].sort((a, b) => a.rows[0].basePriceCents - b.rows[0].basePriceCents)
}

function configLabel(group: PlanGroup) {
  const parts: string[] = []
  if (group.beds != null || group.baths != null) parts.push(`${group.beds ?? "—"} / ${group.baths ?? "—"}`)
  if (group.sqft) parts.push(`${group.sqft.toLocaleString()} sf`)
  if (group.stories) parts.push(`${group.stories} st`)
  if (group.garageBays) parts.push(`${group.garageBays}-car`)
  return parts.join(" · ") || "—"
}

/**
 * What this community sells and for how much — the sales manager's weekly edit,
 * and its only home.
 *
 * Grouped by plan because that is the product: one plan, its elevations under
 * it, priced apart. Every price carries what it is worth as well as what it is —
 * dollars per foot, what the live incentives take off it, and the gross margin
 * left underneath — because a reprice made against the number alone is a guess.
 */
export function OfferingPriceSheet({
  communityId,
  rows,
  incentives,
  minPremiumCents,
  asOfDate,
  lotBasisCents,
  buildCostByPlanId,
  lotsTruncated,
  plansWith3d,
  canManage,
}: {
  communityId: string
  rows: OfferingPlanRow[]
  /** Only the incentives live on `asOfDate` — a scheduled one must not net here. */
  incentives: OfferingIncentive[]
  minPremiumCents: number
  asOfDate: string
  /** Null when the reader cannot see executive numbers; the margin column drops. */
  lotBasisCents: number | null
  buildCostByPlanId: Record<string, number>
  lotsTruncated: boolean
  /** Plan ids with a published 3D model — the rows that get a "3D" button. */
  plansWith3d: ReadonlySet<string>
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({})
  /** Which row is in edit; the sheet is a document until you point at a number. */
  const [editing, setEditing] = useState<string | null>(null)
  const [batch, setBatch] = useState<{ mode: "percent" | "amount"; value: string; excluded: Set<string> } | null>(null)

  const groups = useMemo(() => groupByPlan(rows), [rows])
  /** The sheet's own order, so the reprice preview is the sheet and not a re-sort of it. */
  const ordered = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  // Columns earn their width. Give and net only exist when something is actually
  // coming off the price, and "from" only when a lot premium moves it off base.
  const hasGive = useMemo(
    () => rows.some((row) => offeringPrice(row.basePriceCents, incentives).giveCents > 0),
    [rows, incentives],
  )
  const showFrom = minPremiumCents > 0
  const showMargin = lotBasisCents != null && rows.some((row) => buildCostByPlanId[row.planId] != null)
  const peakVelocity = Math.max(1, ...groups.map((group) => group.soldCount + group.buildingCount))

  function marginFor(row: OfferingPlanRow) {
    if (lotBasisCents == null) return null
    return grossMarginPct({
      priceCents: row.basePriceCents,
      buildCostCents: buildCostByPlanId[row.planId] ?? null,
      lotBasisCents,
    })
  }

  const averagePerFoot = useMemo(() => {
    const priced = rows.filter((row) => row.sqft)
    if (priced.length === 0) return null
    return Math.round(
      priced.reduce((sum, row) => sum + row.basePriceCents / 100 / (row.sqft as number), 0) / priced.length,
    )
  }, [rows])

  function commitPrice(row: OfferingPlanRow) {
    const raw = priceEdits[row.availabilityId]
    setEditing(null)
    if (raw === undefined) return
    const cents = Math.round((Number(raw) || 0) * 100)
    setPriceEdits((current) => {
      const next = { ...current }
      delete next[row.availabilityId]
      return next
    })
    if (cents === row.basePriceCents) return
    startTransition(async () => {
      try {
        unwrapAction(
          await setCommunityPlanPriceAction(communityId, {
            availabilityId: row.availabilityId,
            communityId,
            basePriceCents: cents,
          }),
        )
        toast.success(`${row.planName} repriced to ${money.format(cents / 100)}`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to reprice", { description: (error as Error).message })
      }
    })
  }

  const batchTargets = batch ? ordered.filter((row) => !batch.excluded.has(row.availabilityId)) : []

  function nextPrice(row: OfferingPlanRow) {
    if (!batch) return row.basePriceCents
    const value = Number(batch.value) || 0
    return Math.max(
      0,
      Math.round(batch.mode === "percent" ? row.basePriceCents * (1 + value / 100) : row.basePriceCents + value * 100),
    )
  }

  function applyBatch() {
    if (!batch || !Number(batch.value) || batchTargets.length === 0) return
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await bulkRepriceCommunityPlansAction(communityId, {
            communityId,
            availabilityIds: batchTargets.map((row) => row.availabilityId),
            mode: batch.mode,
            value: batch.mode === "percent" ? Number(batch.value) : Math.round(Number(batch.value) * 100),
          }),
        )
        toast.success(`${result.repriced} ${result.repriced === 1 ? "plan" : "plans"} repriced`)
        setBatch(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to reprice", { description: (error as Error).message })
      }
    })
  }

  /** Plans the pending move would push under a margin worth building at. */
  const batchThin = batch
    ? batchTargets.filter((row) => {
        if (lotBasisCents == null) return false
        const pct = grossMarginPct({
          priceCents: nextPrice(row),
          buildCostCents: buildCostByPlanId[row.planId] ?? null,
          lotBasisCents,
        })
        return pct != null && pct < THIN_MARGIN_PCT
      }).length
    : 0

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="microlabel">Price sheet</h2>
          <p className="text-[11px] text-muted-foreground">
            {rows.length === 0
              ? "nothing released here yet"
              : `${groups.length} ${groups.length === 1 ? "plan" : "plans"} · ${rows.length} ${rows.length === 1 ? "elevation" : "elevations"} priced`}
            {canManage && rows.length > 0 ? " · click a base price to change it" : ""}
          </p>
        </div>
        {canManage && rows.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 rounded-none text-xs"
            onClick={() => setBatch({ mode: "percent", value: "", excluded: new Set() })}
          >
            Reprice sheet
          </Button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <p className="text-xs font-medium">No plans are released here</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            A community has nothing to sell until a plan is published to it. Release plans from the library, then set
            what they cost here.
          </p>
          <Button asChild variant="outline" size="sm" className="mt-3 rounded-none text-xs">
            <Link href="/plans">Open the plan library</Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="microlabel hover:bg-transparent">
                <TableHead>Plan</TableHead>
                <TableHead>Elevation</TableHead>
                <TableHead>Config</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">$/sf</TableHead>
                {hasGive ? <TableHead className="text-right">Give</TableHead> : null}
                {hasGive ? <TableHead className="text-right">Net</TableHead> : null}
                {showFrom ? <TableHead className="text-right">From</TableHead> : null}
                {showMargin ? <TableHead className="text-right">Margin</TableHead> : null}
                <TableHead className="w-32 text-right">Sold / building</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.planId}>
                  {group.rows.map((row, index) => {
                    const price = offeringPrice(row.basePriceCents, incentives)
                    const margin = marginFor(row)
                    const band = marginBand(margin)
                    const move =
                      row.previousBasePriceCents == null ? null : row.basePriceCents - row.previousBasePriceCents
                    const isLast = index === group.rows.length - 1
                    const velocity = group.soldCount + group.buildingCount
                    return (
                      <TableRow key={row.key} className={cn("text-xs", !isLast && "border-b-0")}>
                        <TableCell className="font-medium">
                          {index === 0 ? (
                            <span className="flex items-center gap-1">
                              <Link className="hover:underline" href={`/plans/${row.planId}`}>
                                {row.planCode ? <span className="font-mono">{row.planCode}</span> : null}
                                {row.planCode ? " · " : ""}
                                {row.planName}
                              </Link>
                              {plansWith3d.has(row.planId) ? (
                                <Plan3dDialog
                                  planId={row.planId}
                                  planLabel={`${row.planCode ? `${row.planCode} — ` : ""}${row.planName}`}
                                  className="h-6 gap-1 rounded-none px-1.5 text-[10px]"
                                />
                              ) : null}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {group.rows.length === 1 && row.elevationName === "Standard" ? "—" : row.elevationName}
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {index === 0 ? configLabel(group) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {canManage && editing === row.availabilityId ? (
                            <Input
                              autoFocus
                              inputMode="decimal"
                              aria-label={`Base price for ${row.planName} ${row.elevationName}`}
                              className="ml-auto h-7 w-32 rounded-none text-right text-xs tabular-nums"
                              disabled={isPending}
                              value={priceEdits[row.availabilityId] ?? (row.basePriceCents / 100).toFixed(2)}
                              onChange={(event) =>
                                setPriceEdits((current) => ({ ...current, [row.availabilityId]: event.target.value }))
                              }
                              onBlur={() => commitPrice(row)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") event.currentTarget.blur()
                                if (event.key === "Escape") {
                                  setPriceEdits((current) => {
                                    const next = { ...current }
                                    delete next[row.availabilityId]
                                    return next
                                  })
                                  setEditing(null)
                                }
                              }}
                            />
                          ) : canManage ? (
                            <button
                              type="button"
                              className="tabular-nums underline decoration-dotted underline-offset-4 hover:text-foreground"
                              onClick={() => setEditing(row.availabilityId)}
                            >
                              {money.format(row.basePriceCents / 100)}
                            </button>
                          ) : (
                            money.format(row.basePriceCents / 100)
                          )}
                          {row.repricedAt ? (
                            <span className="mt-0.5 block text-[10px] text-muted-foreground">
                              {move != null && move !== 0 ? (
                                <span className={move > 0 ? "text-success" : "text-destructive"}>
                                  {move > 0 ? "+" : "−"}
                                  {shortMoney(Math.abs(move))}{" "}
                                </span>
                              ) : null}
                              {readableDate(row.repricedAt)}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {row.sqft ? `$${Math.round(row.basePriceCents / 100 / row.sqft)}` : "—"}
                        </TableCell>
                        {hasGive ? (
                          <TableCell className="text-right tabular-nums text-warning">
                            {price.giveCents > 0 ? `−${money.format(price.giveCents / 100)}` : <span className="text-muted-foreground/60">—</span>}
                          </TableCell>
                        ) : null}
                        {hasGive ? (
                          <TableCell className="text-right font-medium tabular-nums">
                            {money.format(price.netCents / 100)}
                          </TableCell>
                        ) : null}
                        {showFrom ? (
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {money.format((price.netCents + minPremiumCents) / 100)}
                          </TableCell>
                        ) : null}
                        {showMargin ? (
                          <TableCell className={cn("text-right tabular-nums", MARGIN_BAND_META[band].text)}>
                            {margin == null ? <span className="text-muted-foreground/60">—</span> : `${Math.round(margin)}%`}
                          </TableCell>
                        ) : null}
                        <TableCell className="text-right">
                          {index === 0 ? (
                            <>
                              <span className="tabular-nums">
                                {velocity === 0 ? (
                                  <span className="text-muted-foreground/60">not selling</span>
                                ) : (
                                  <>
                                    {group.soldCount}
                                    <span className="text-muted-foreground"> / {group.buildingCount}</span>
                                  </>
                                )}
                              </span>
                              <span
                                className="mt-1 flex h-1 w-full bg-muted"
                                role="img"
                                aria-label={`${group.soldCount} closed, ${group.buildingCount} building`}
                              >
                                <span
                                  className="bg-chart-1"
                                  style={{ width: `${(group.soldCount / peakVelocity) * 100}%` }}
                                />
                                <span
                                  className="bg-chart-2"
                                  style={{ width: `${(group.buildingCount / peakVelocity) * 100}%` }}
                                />
                              </span>
                            </>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </Fragment>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="text-xs hover:bg-transparent">
                <TableCell colSpan={4} className="font-normal text-muted-foreground">
                  Priced as of {asOfDate}
                  {lotsTruncated ? " · velocity and premiums read the first 5,000 lots" : ""}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {averagePerFoot != null ? `$${averagePerFoot} avg` : "—"}
                </TableCell>
                {hasGive ? <TableCell /> : null}
                {hasGive ? <TableCell /> : null}
                {showFrom ? <TableCell /> : null}
                {showMargin ? <TableCell /> : null}
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {groups.reduce((sum, group) => sum + group.soldCount, 0)}
                  {" / "}
                  {groups.reduce((sum, group) => sum + group.buildingCount, 0)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}

      <Dialog open={Boolean(batch)} onOpenChange={(open) => { if (!open) setBatch(null) }}>
        <DialogContent className="rounded-none sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Reprice the sheet</DialogTitle>
            <DialogDescription>
              Moves every checked elevation by the same amount. Uncheck the ones holding their price — an entry plan
              usually does.
            </DialogDescription>
          </DialogHeader>
          {batch ? (
            <div className="grid gap-3">
              <div className="grid grid-cols-[10rem_1fr] gap-3">
                <div className="grid gap-1.5">
                  <Label className="microlabel">Move by</Label>
                  <Select
                    value={batch.mode}
                    onValueChange={(value) => setBatch({ ...batch, mode: value as "percent" | "amount" })}
                  >
                    <SelectTrigger className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">Percent</SelectItem>
                      <SelectItem value="amount">Dollars</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="batch-value" className="microlabel">
                    {batch.mode === "percent" ? "Percent" : "Amount"}
                  </Label>
                  <Input
                    id="batch-value"
                    autoFocus
                    inputMode="decimal"
                    className="h-8 rounded-none text-xs tabular-nums"
                    value={batch.value}
                    onChange={(event) => setBatch({ ...batch, value: event.target.value })}
                    placeholder={batch.mode === "percent" ? "2" : "5000"}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">A negative number cuts prices.</p>
              <div className="max-h-72 overflow-y-auto border">
                <Table>
                  <TableHeader>
                    <TableRow className="microlabel hover:bg-transparent">
                      <TableHead className="w-8" />
                      <TableHead>Plan</TableHead>
                      <TableHead className="text-right">Now</TableHead>
                      <TableHead className="text-right">Becomes</TableHead>
                      {showMargin ? <TableHead className="text-right">Margin</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {ordered.map((row) => {
                      const excluded = batch.excluded.has(row.availabilityId)
                      const next = nextPrice(row)
                      const pct =
                        lotBasisCents == null
                          ? null
                          : grossMarginPct({
                              priceCents: excluded ? row.basePriceCents : next,
                              buildCostCents: buildCostByPlanId[row.planId] ?? null,
                              lotBasisCents,
                            })
                      return (
                        <TableRow key={row.key} className={cn("text-xs", excluded && "opacity-50")}>
                          <TableCell>
                            <Checkbox
                              aria-label={`Reprice ${row.planName} ${row.elevationName}`}
                              checked={!excluded}
                              onCheckedChange={() =>
                                setBatch((current) => {
                                  if (!current) return current
                                  const next = new Set(current.excluded)
                                  if (next.has(row.availabilityId)) next.delete(row.availabilityId)
                                  else next.add(row.availabilityId)
                                  return { ...current, excluded: next }
                                })
                              }
                            />
                          </TableCell>
                          <TableCell>
                            {row.planName}
                            <span className="text-muted-foreground"> · {row.elevationName}</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {money.format(row.basePriceCents / 100)}
                          </TableCell>
                          <TableCell className="text-right font-medium tabular-nums">
                            {excluded ? <span className="text-muted-foreground">unchanged</span> : money.format(next / 100)}
                          </TableCell>
                          {showMargin ? (
                            <TableCell className={cn("text-right tabular-nums", MARGIN_BAND_META[marginBand(pct)].text)}>
                              {pct == null ? "—" : `${Math.round(pct)}%`}
                            </TableCell>
                          ) : null}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {batchThin > 0 ? (
                <p className="text-xs text-warning">
                  {batchThin} {batchThin === 1 ? "elevation lands" : "elevations land"} under {THIN_MARGIN_PCT}% gross
                  after this move.
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" className="rounded-none" onClick={() => setBatch(null)}>
              Cancel
            </Button>
            <Button
              className="rounded-none"
              disabled={!Number(batch?.value) || batchTargets.length === 0 || isPending}
              onClick={applyBatch}
            >
              {isPending
                ? "Repricing…"
                : `Reprice ${batchTargets.length} ${batchTargets.length === 1 ? "elevation" : "elevations"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
