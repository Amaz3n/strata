"use client"

import Link from "next/link"
import { useMemo, useState } from "react"

import { AlertTriangle, Home, ImageIcon, Search } from "@/components/icons"
import { NewPlanSheet } from "@/components/plans/new-plan-sheet"
import { PlanStatusBadge } from "@/components/plans/plan-badges"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DivisionDTO } from "@/lib/services/divisions"
import type { CommunityListItemDTO } from "@/lib/services/communities"
import type { PlanAttentionDto, PlanLadderRungDto } from "@/lib/services/house-plans"
import { MARGIN_BAND_META, grossMarginPct, marginBand } from "@/lib/plans/margin"
import { cn } from "@/lib/utils"

type AttentionFilter = "all" | "attention" | "drafts" | "unpriced" | "margin"

const ATTENTION_FILTERS: Array<{ key: AttentionFilter; label: string; detail: string }> = [
  { key: "all", label: "All plans", detail: "The complete library" },
  { key: "attention", label: "Needs attention", detail: "Any open exception" },
  { key: "drafts", label: "Open drafts", detail: "Edition work in progress" },
  { key: "unpriced", label: "Unpriced", detail: "Cost or community gaps" },
  { key: "margin", label: "Margin risk", detail: "Thin or implausible" },
]

function money(cents: number): string {
  const dollars = cents / 100
  return dollars >= 1_000_000 ? `$${(dollars / 1_000_000).toFixed(2)}M` : `$${Math.round(dollars / 1000)}k`
}

function priceBand(rung: PlanLadderRungDto): string {
  if (rung.base_price_min_cents == null || rung.base_price_max_cents == null) return "—"
  if (rung.base_price_min_cents === rung.base_price_max_cents) return money(rung.base_price_min_cents)
  return `${money(rung.base_price_min_cents)}–${money(rung.base_price_max_cents)}`
}

function specLine(rung: PlanLadderRungDto): string {
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
function marginPct(rung: PlanLadderRungDto): number | null {
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

function PlanThumb({ rung }: { rung: PlanLadderRungDto }) {
  const fileId = rung.cover_file_id ?? rung.elevation_cover_file_ids[0] ?? null
  if (!fileId) {
    return (
      <div className="flex h-12 w-16 shrink-0 items-center justify-center border bg-muted/40 text-muted-foreground">
        <ImageIcon className="h-4 w-4" />
      </div>
    )
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element -- files are streamed through an authenticated org-scoped route, not a static asset host */
    <img
      src={`/api/files/${fileId}/raw`}
      alt=""
      className="h-12 w-16 shrink-0 border object-cover"
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
  rungs: PlanLadderRungDto[]
  divisions: DivisionDTO[]
  communities: CommunityListItemDTO[]
  canWrite: boolean
}) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState("all")
  const [seriesFilter, setSeriesFilter] = useState("all")
  const [communityFilter, setCommunityFilter] = useState("all")
  const [attentionFilter, setAttentionFilter] = useState<AttentionFilter>("all")
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
            (communityFilter === "all" || rung.community_ids.includes(communityFilter)) &&
            matchesAttentionFilter(rung, attentionFilter)
          )
        })
        .sort((a, b) => (a.heated_sqft ?? Number.MAX_SAFE_INTEGER) - (b.heated_sqft ?? Number.MAX_SAFE_INTEGER)),
    [rungs, query, status, seriesFilter, communityFilter, attentionFilter],
  )
  const attentionCounts = useMemo(() => buildAttentionCounts(rungs), [rungs])

  const createControl = canWrite ? <NewPlanSheet divisions={divisions} /> : null

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
          {canWrite ? <EmptyContent>{createControl}</EmptyContent> : null}
        </Empty>
      </div>
    )
  }

  return (
    <div className="flex min-h-full flex-col">
      <nav aria-label="Plan attention filters" className="flex shrink-0 overflow-x-auto border-b">
        {ATTENTION_FILTERS.map((item) => {
          const selected = attentionFilter === item.key
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={selected}
              onClick={() => setAttentionFilter(item.key)}
              className={cn(
                "flex min-w-[148px] flex-1 items-center justify-between gap-3 border-r px-4 py-2.5 text-left transition-colors last:border-r-0",
                selected ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/40",
              )}
            >
              <span>
                <span className="block text-[10px] uppercase tracking-wide">{item.label}</span>
                <span className="mt-0.5 block text-[10px]">{item.detail}</span>
              </span>
              <span className={cn("font-mono text-lg tabular-nums", selected && "text-primary")}>
                {attentionCounts[item.key]}
              </span>
            </button>
          )
        })}
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
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
          </span>
        </div>
        {createControl}
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
              setAttentionFilter("all")
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="p-4">
          <div className="border">
            {filtered.map((rung) => {
              const pct = marginPct(rung)
              return (
                <Link
                  key={rung.id}
                  href={`/plans/${rung.id}`}
                  className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 border-b p-3 transition-colors last:border-b-0 hover:bg-muted/40 xl:grid-cols-[64px_minmax(220px,1.6fr)_repeat(5,minmax(82px,0.7fr))_auto] xl:items-center"
                >
                  <PlanThumb rung={rung} />
                  <div className="min-w-0">
                    <div className="min-w-0">
                      <span className="font-mono text-xs font-medium">{rung.code}</span>
                      <span className="ml-2 text-sm font-medium">{rung.name}</span>
                      {rung.series ? <span className="ml-2 text-[11px] text-muted-foreground">{rung.series}</span> : null}
                    </div>
                    <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{specLine(rung)}</p>

                    {rung.attention.length > 0 ? (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {rung.attention.slice(0, 2).map((item) => (
                          <span
                            key={item.kind}
                            className={cn(
                              "inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px]",
                              item.kind === "thin_margin" ||
                                item.kind === "implausible_margin" ||
                                item.kind === "unpriced_takeoff"
                                ? "border-warning/50 bg-warning/10 text-warning"
                                : "border-border bg-muted text-muted-foreground",
                            )}
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {item.label}
                          </span>
                        ))}
                        {rung.attention.length > 2 ? (
                          <span className="border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            +{rung.attention.length - 2} more
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="col-start-2 mt-1 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5 xl:col-auto xl:contents">
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
                      label="Edition"
                      value={rung.released_version_number != null ? `v${rung.released_version_number}` : "None"}
                      hint={rung.draft_version_number != null ? `v${rung.draft_version_number} draft` : undefined}
                    />
                    <Metric
                      label="Usage"
                      value={`${rung.lots_total} lots`}
                      hint={`${rung.lots_building} building · ${rung.lots_closed} closed`}
                    />
                  </div>
                  <div className="col-start-2 flex justify-start xl:col-auto xl:justify-end">
                    <PlanStatusBadge status={rung.status} />
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

function hasAttentionKind(rung: PlanLadderRungDto, kinds: PlanAttentionDto["kind"][]): boolean {
  return rung.attention.some((item) => kinds.includes(item.kind))
}

function matchesAttentionFilter(rung: PlanLadderRungDto, filter: AttentionFilter): boolean {
  if (filter === "all") return true
  if (filter === "attention") return rung.attention.length > 0
  if (filter === "drafts") return hasAttentionKind(rung, ["open_draft"])
  if (filter === "unpriced") return hasAttentionKind(rung, ["unpriced_takeoff", "unpriced_community"])
  return hasAttentionKind(rung, ["thin_margin", "implausible_margin"])
}

function buildAttentionCounts(rungs: PlanLadderRungDto[]): Record<AttentionFilter, number> {
  return {
    all: rungs.length,
    attention: rungs.filter((rung) => matchesAttentionFilter(rung, "attention")).length,
    drafts: rungs.filter((rung) => matchesAttentionFilter(rung, "drafts")).length,
    unpriced: rungs.filter((rung) => matchesAttentionFilter(rung, "unpriced")).length,
    margin: rungs.filter((rung) => matchesAttentionFilter(rung, "margin")).length,
  }
}
