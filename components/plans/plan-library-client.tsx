"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Home, Plus, Search } from "@/components/icons"
import { createHousePlanAction } from "@/app/(app)/plans/actions"
import { PlanStatusBadge } from "@/components/plans/plan-badges"
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
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { DivisionDTO } from "@/lib/services/divisions"
import type { HousePlanDto } from "@/lib/services/house-plans"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import { formatMoneyCents } from "@/lib/utils"

function priceRange(plan: HousePlanDto): string {
  if (plan.base_price_min_cents == null || plan.base_price_max_cents == null) return "—"
  if (plan.base_price_min_cents === plan.base_price_max_cents) return formatMoneyCents(plan.base_price_min_cents)
  return `${formatMoneyCents(plan.base_price_min_cents)}–${formatMoneyCents(plan.base_price_max_cents)}`
}

function specs(plan: HousePlanDto): string {
  const parts = [
    plan.beds != null || plan.baths != null ? `${plan.beds ?? "—"}bd/${plan.baths ?? "—"}ba` : null,
    plan.stories != null ? `${plan.stories}st` : null,
    plan.garage_bays != null ? `${plan.garage_bays}car` : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : "—"
}

export function PlanLibraryClient({
  plans,
  divisions,
  communities,
  canWrite,
}: {
  plans: HousePlanDto[]
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
  const [divisionFilter, setDivisionFilter] = useState("all")
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
  const divisionNames = useMemo(() => new Map(divisions.map((division) => [division.id, division.name])), [divisions])
  const seriesOptions = useMemo(
    () => Array.from(new Set(plans.map((plan) => plan.series).filter((value): value is string => Boolean(value)))).sort(),
    [plans],
  )
  const filtered = useMemo(
    () =>
      plans.filter((plan) => {
        const haystack = `${plan.code} ${plan.name} ${plan.series ?? ""}`.toLowerCase()
        return (
          haystack.includes(query.trim().toLowerCase()) &&
          (status === "all" || plan.status === status) &&
          (seriesFilter === "all" || plan.series === seriesFilter) &&
          (divisionFilter === "all" || plan.division_id === divisionFilter) &&
          (communityFilter === "all" || plan.community_ids.includes(communityFilter))
        )
      }),
    [plans, query, status, seriesFilter, divisionFilter, communityFilter],
  )
  const totals = useMemo(
    () => ({
      lots: filtered.reduce((sum, plan) => sum + plan.active_lot_count, 0),
      released: filtered.filter((plan) => plan.current_released_version != null).length,
    }),
    [filtered],
  )

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
          <DialogDescription>Creates the catalog record with a v1 draft. Takeoff, bundle, and pricing live on the plan.</DialogDescription>
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
            <Input id="plan-code" autoFocus value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="1670" maxLength={32} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plan-name">Name</Label>
            <Input id="plan-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Magnolia" />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="plan-series">Series <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="plan-series" value={series} onChange={(event) => setSeries(event.target.value)} placeholder="Coastal" />
          </div>
          {activeDivisions.length > 0 ? (
            <div className="grid gap-1.5">
              <Label>Division</Label>
              <Select value={divisionId} onValueChange={setDivisionId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Org-wide</SelectItem>
                  {activeDivisions.map((division) => (
                    <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="grid grid-cols-4 gap-2 sm:col-span-2">
            <div className="grid gap-1.5">
              <Label htmlFor="plan-sqft" className="text-xs">Heated sqft</Label>
              <Input id="plan-sqft" inputMode="numeric" value={heatedSqft} onChange={(event) => setHeatedSqft(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-beds" className="text-xs">Beds</Label>
              <Input id="plan-beds" inputMode="numeric" value={beds} onChange={(event) => setBeds(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-baths" className="text-xs">Baths</Label>
              <Input id="plan-baths" inputMode="decimal" value={baths} onChange={(event) => setBaths(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="plan-garage" className="text-xs">Garage</Label>
              <Input id="plan-garage" inputMode="numeric" value={garageBays} onChange={(event) => setGarageBays(event.target.value)} />
            </div>
          </div>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button form="create-plan" type="submit" disabled={pending || !code.trim() || !name.trim()}>
            {pending ? "Creating…" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null

  if (plans.length === 0) {
    return (
      <div className="flex min-h-full flex-col p-4">
        <Empty className="flex-1 rounded-none border">
          <EmptyHeader>
            <EmptyMedia variant="icon" className="rounded-none"><Home /></EmptyMedia>
            <EmptyTitle className="text-sm">No house plans yet</EmptyTitle>
            <EmptyDescription className="text-xs">
              The plan library is your bill of process: each plan carries its elevations, takeoff, template bundle, and community pricing. Estimate once per plan — every start is generated from it.
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
            <SelectTrigger className="h-8 w-32 rounded-none text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="retired">Retired</SelectItem>
            </SelectContent>
          </Select>
          {seriesOptions.length > 0 ? (
            <Select value={seriesFilter} onValueChange={setSeriesFilter}>
              <SelectTrigger className="h-8 w-36 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All series</SelectItem>
                {seriesOptions.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          {activeDivisions.length > 0 ? (
            <Select value={divisionFilter} onValueChange={setDivisionFilter}>
              <SelectTrigger className="h-8 w-40 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All divisions</SelectItem>
                {activeDivisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          {communities.length > 0 ? (
            <Select value={communityFilter} onValueChange={setCommunityFilter}>
              <SelectTrigger className="h-8 w-44 rounded-none text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All communities</SelectItem>
                {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}
          <span className="text-xs tabular-nums text-muted-foreground">
            {filtered.length === 1 ? "1 plan" : `${filtered.length} plans`} · {totals.released} released · {totals.lots} active lots
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
              setDivisionFilter("all")
              setCommunityFilter("all")
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="p-4">
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide">
                  <TableHead>Plan</TableHead>
                  <TableHead>Series</TableHead>
                  {activeDivisions.length > 0 ? <TableHead>Division</TableHead> : null}
                  <TableHead className="text-right">Heated sqft</TableHead>
                  <TableHead>Specs</TableHead>
                  <TableHead className="text-right">Elev.</TableHead>
                  <TableHead className="text-right">Released</TableHead>
                  <TableHead className="text-right">Base price</TableHead>
                  <TableHead className="text-right">Communities</TableHead>
                  <TableHead className="text-right">Active lots</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((plan) => (
                  <TableRow key={plan.id} className="cursor-pointer text-xs" onClick={() => router.push(`/plans/${plan.id}`)}>
                    <TableCell className="font-medium">
                      <Link className="hover:underline" href={`/plans/${plan.id}`} onClick={(event) => event.stopPropagation()}>
                        <span className="font-mono">{plan.code}</span>
                        <span className="ml-2">{plan.name}</span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{plan.series ?? "—"}</TableCell>
                    {activeDivisions.length > 0 ? (
                      <TableCell className="text-muted-foreground">{plan.division_id ? divisionNames.get(plan.division_id) ?? "—" : "Org-wide"}</TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums">{plan.heated_sqft?.toLocaleString() ?? "—"}</TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">{specs(plan)}</TableCell>
                    <TableCell className="text-right tabular-nums">{plan.elevation_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{plan.current_released_version ? `v${plan.current_released_version}` : "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{priceRange(plan)}</TableCell>
                    <TableCell className="text-right tabular-nums">{plan.community_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{plan.active_lot_count}</TableCell>
                    <TableCell><PlanStatusBadge status={plan.status} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
              {filtered.length > 1 ? (
                <TableFooter>
                  <TableRow className="text-xs">
                    <TableCell colSpan={activeDivisions.length > 0 ? 9 : 8} className="font-medium">All plans</TableCell>
                    <TableCell className="text-right tabular-nums font-medium">{totals.lots}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              ) : null}
            </Table>
          </div>
        </div>
      )}
    </div>
  )
}
