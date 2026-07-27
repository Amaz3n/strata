"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { AlertTriangle, Home, ImageIcon, Plus, Search } from "@/components/icons"
import { createHousePlanAction } from "@/app/(app)/plans/actions"
import { PlanStatusBadge } from "@/components/plans/plan-badges"
import { PlanLadder, type LadderRung } from "@/components/plans/plan-ladder"
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
import type { DivisionDTO } from "@/lib/services/divisions"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import { MARGIN_BAND_META, grossMarginPct, marginBand } from "@/lib/plans/margin"
import { cn } from "@/lib/utils"

function money(cents: number): string {
  const dollars = cents / 100
  return dollars >= 1_000_000 ? `$${(dollars / 1_000_000).toFixed(2)}M` : `$${Math.round(dollars / 1000)}k`
}

function priceBand(rung: LadderRung): string {
  if (rung.base_price_min_cents == null || rung.base_price_max_cents == null) return "—"
  if (rung.base_price_min_cents === rung.base_price_max_cents) return money(rung.base_price_min_cents)
  return `${money(rung.base_price_min_cents)}–${money(rung.base_price_max_cents)}`
}

function specLine(rung: LadderRung): string {
  return [
    rung.heated_sqft != null ? `${rung.heated_sqft.toLocaleString()} sf` : null,
    rung.beds != null || rung.baths != null ? `${rung.beds ?? "—"} bd / ${rung.baths ?? "—"} ba` : null,
    rung.stories != null ? `${rung.stories} ${rung.stories === 1 ? "story" : "stories"}` : null,
    rung.garage_bays != null ? `${rung.garage_bays}-car` : null,
    `${rung.elevation_count} ${rung.elevation_count === 1 ? "elevation" : "elevations"}`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Price less what it costs to deliver: construction plus the lot it sits on. */
function marginPct(rung: LadderRung): number | null {
  return grossMarginPct({
    priceCents: rung.base_price_min_cents,
    buildCostCents: rung.released_cost_cents,
    lotBasisCents: rung.lot_basis_cents,
  })
}

function marginText(pct: number | null): string {
  return MARGIN_BAND_META[marginBand(pct)].text
}

function Metric({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("text-xs font-medium tabular-nums", tone)}>{value}</p>
      {hint ? <p className="text-[10px] tabular-nums text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function PlanThumb({ rung }: { rung: LadderRung }) {
  const fileId = rung.cover_file_id ?? rung.elevation_cover_file_ids[0] ?? null
  if (!fileId) {
    return (
      <div className="flex h-[57px] w-[76px] shrink-0 items-center justify-center border bg-muted/40 text-muted-foreground">
        <ImageIcon className="h-4 w-4" />
      </div>
    )
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element -- files are streamed through an authenticated org-scoped route, not a static asset host */
    <img
      src={`/api/files/${fileId}/raw`}
      alt=""
      className="h-[57px] w-[76px] shrink-0 border object-cover"
      loading="lazy"
    />
  )
}

export function PlanLibraryClient({
  rungs,
  divisions,
  communities,
  canWrite,
}: {
  rungs: LadderRung[]
  divisions: DivisionDTO[]
  communities: CommunityListItemDTO[]
  canWrite: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [seriesFilter, setSeriesFilter] = useState("all")
  const [communityFilter, setCommunityFilter] = useState("all")
  const [code, setCode] = useState("")
  const [name, setName] = useState("")
  const [series, setSeries] = useState("")
  const [divisionId, setDivisionId] = useState("none")
  const [heatedSqft, setHeatedSqft] = useState("")
  const [beds, setBeds] = useState("")
  const [baths, setBaths] = useState("")
  const [garageBays, setGarageBays] = useState("")

  const activeDivisions = useMemo(() => divisions.filter((division) => !division.archived), [divisions])
  const seriesOptions = useMemo(
    () => Array.from(new Set(rungs.map((rung) => rung.series).filter((value): value is string => Boolean(value)))).sort(),
    [rungs],
  )
  const filtered = useMemo(
    () =>
      rungs
        .filter((rung) => {
          const haystack = `${rung.code} ${rung.name} ${rung.series ?? ""}`.toLowerCase()
          return (
            haystack.includes(query.trim().toLowerCase()) &&
            (status === "all" || rung.status === status) &&
            (seriesFilter === "all" || rung.series === seriesFilter) &&
            (communityFilter === "all" || rung.community_ids.includes(communityFilter))
          )
        })
        .sort((a, b) => (a.heated_sqft ?? Number.MAX_SAFE_INTEGER) - (b.heated_sqft ?? Number.MAX_SAFE_INTEGER)),
    [rungs, query, status, seriesFilter, communityFilter],
  )
  const needsAttention = useMemo(() => filtered.filter((rung) => rung.attention.length > 0).length, [filtered])

  function create() {
    startTransition(async () => {
      try {
        const plan = unwrapAction(
          await createHousePlanAction({
            code,
            name,
            series: series.trim() || null,
            divisionId: divisionId === "none" ? null : divisionId,
            status: "draft",
            heatedSqft: heatedSqft ? Number(heatedSqft) : null,
            beds: beds ? Number(beds) : null,
            baths: baths ? Number(baths) : null,
            garageBays: garageBays ? Number(garageBays) : null,
          }),
        )
        toast.success("Plan created")
        setOpen(false)
        router.push(`/plans/${plan.id}`)
      } catch (error) {
        toast.error("Unable to create plan", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  const createDialog = canWrite ? (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="rounded-none">
          <Plus className="mr-1.5 h-4 w-4" />
          New plan
        </Button>
      </DialogTrigger>
      <DialogContent className="rounded-none sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New house plan</DialogTitle>
          <DialogDescription>
            Creates the catalog record with a v1 draft. Takeoff, bundle, and community pricing live on the plan.
          </DialogDescription>
        </DialogHeader>
        <form
          id="create-plan"
          className="grid gap-4 py-2 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim() && name.trim() && !pending) create()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="plan-code">Code</Label>
            <Input
              id="plan-code"
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="1670"
              maxLength={32}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plan-name">Name</Label>
            <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Magnolia" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plan-series">
              Series <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input id="plan-series" value={series} onChange={(event) => setSeries(event.target.value)} placeholder="Coastal" />
          </div>
          {activeDivisions.length > 0 ? (
            <div className="grid gap-1.5">
              <Label>Division</Label>
              <Select value={divisionId} onValueChange={setDivisionId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Org-wide</SelectItem>
                  {activeDivisions.map((division) => (
                    <SelectItem key={division.id} value={division.id}>
                      {division.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid grid-cols-4 gap-2 sm:col-span-2">
            <div className="grid gap-1.5">
              <Label htmlFor="plan-sqft" className="text-xs">
                Heated sqft
              </Label>
              <Input id="plan-sqft" inputMode="numeric" value={heatedSqft} onChange={(event) => setHeatedSqft(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-beds" className="text-xs">
                Beds
              </Label>
              <Input id="plan-beds" inputMode="numeric" value={beds} onChange={(event) => setBeds(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-baths" className="text-xs">
                Baths
              </Label>
              <Input id="plan-baths" inputMode="decimal" value={baths} onChange={(event) => setBaths(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-garage" className="text-xs">
                Garage
              </Label>
              <Input id="plan-garage" inputMode="numeric" value={garageBays} onChange={(event) => setGarageBays(event.target.value)} />
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button form="create-plan" type="submit" disabled={pending || !code.trim() || !name.trim()}>
            {pending ? "Creating…" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  if (rungs.length === 0) {
    return (
      <div className="flex min-h-full flex-col p-4">
        <Empty className="flex-1 rounded-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-none">
              <Home />
            </EmptyMedia>
            <EmptyTitle className="text-sm">No house plans yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              The plan library is your bill of process: each plan carries its elevations, takeoff, template bundle, and
              community pricing. Estimate once per plan — every start is generated from it.
            </EmptyDescription>
          </EmptyHeader>
          {canWrite ? <EmptyContent>{createDialog}</EmptyContent> : null}
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              className="h-8 w-52 rounded-none pl-8 text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search code, name, series"
              aria-label="Search plans"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-8 w-32 rounded-none text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="retired">Retired</SelectItem>
            </SelectContent>
          </Select>
          {seriesOptions.length > 0 ? (
            <Select value={seriesFilter} onValueChange={setSeriesFilter}>
              <SelectTrigger className="h-8 w-36 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All series</SelectItem>
                {seriesOptions.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {communities.length > 0 ? (
            <Select value={communityFilter} onValueChange={setCommunityFilter}>
              <SelectTrigger className="h-8 w-44 rounded-none text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All communities</SelectItem>
                {communities.map((community) => (
                  <SelectItem key={community.id} value={community.id}>
                    {community.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {filtered.length === 1 ? "1 plan" : `${filtered.length} plans`}
            {needsAttention > 0 ? ` · ${needsAttention} need attention` : ""}
          </span>
        </div>
        {createDialog}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No matching plans</p>
          <p className="max-w-md text-xs text-muted-foreground">Nothing matches the current search and filters.</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2 rounded-none"
            onClick={() => {
              setQuery("")
              setStatus("all")
              setSeriesFilter("all")
              setCommunityFilter("all")
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="space-y-4 p-4">
          <PlanLadder rungs={filtered} />

          <div className="border">
            {filtered.map((rung) => {
              const pct = marginPct(rung)
              return (
                <Link
                  key={rung.id}
                  href={`/plans/${rung.id}`}
                  className="grid grid-cols-[76px_minmax(0,1fr)] gap-4 border-b p-3 last:border-b-0 hover:bg-muted/40"
                >
                  <PlanThumb rung={rung} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <div className="min-w-0">
                        <span className="font-mono text-xs font-medium">{rung.code}</span>
                        <span className="ml-2 text-sm font-medium">{rung.name}</span>
                        {rung.series ? <span className="ml-2 text-[11px] text-muted-foreground">{rung.series}</span> : null}
                      </div>
                      <PlanStatusBadge status={rung.status} />
                    </div>
                    <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{specLine(rung)}</p>

                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
                      <Metric
                        label="Price"
                        value={priceBand(rung)}
                        hint={`${rung.community_count} ${rung.community_count === 1 ? "community" : "communities"}`}
                      />
                      <Metric
                        label="Build cost"
                        value={rung.released_cost_cents != null ? money(rung.released_cost_cents) : "—"}
                        hint={
                          rung.released_cost_cents != null && rung.heated_sqft
                            ? `$${Math.round(rung.released_cost_cents / 100 / rung.heated_sqft)}/sf`
                            : undefined
                        }
                      />
                      <Metric
                        label="Gross margin"
                        value={pct != null ? `${Math.round(pct)}%` : "—"}
                        hint={
                          pct != null && rung.lot_basis_cents != null
                            ? `incl. ${money(rung.lot_basis_cents)} lot`
                            : rung.lot_basis_cents == null
                              ? "needs lot basis"
                              : undefined
                        }
                        tone={marginText(pct)}
                      />
                      <Metric
                        label="Released"
                        value={rung.released_version_number != null ? `v${rung.released_version_number}` : "None"}
                        hint={rung.draft_version_number != null ? `v${rung.draft_version_number} draft` : undefined}
                      />
                      <Metric
                        label="Lots"
                        value={String(rung.lots_total)}
                        hint={`${rung.lots_building} building · ${rung.lots_closed} closed`}
                      />
                      <Metric
                        label="Cycle"
                        value={rung.cycle_median_days != null ? `${rung.cycle_median_days}d` : "—"}
                        hint={rung.cycle_median_days != null ? "median start→complete" : undefined}
                      />
                    </div>

                    {rung.attention.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {rung.attention.map((item) => (
                          <span
                            key={item.kind}
                            className={cn(
                              "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px]",
                              item.kind === "thin_margin" || item.kind === "unpriced_takeoff"
                                ? "border-warning/50 bg-warning/10 text-warning"
                                : "border-border bg-muted text-muted-foreground",
                            )}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {item.label}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </Link>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
