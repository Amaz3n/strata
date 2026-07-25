"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"

import { ChevronRight, Lock, Plus, Search } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { setCommunityContextAction, setDivisionContextAction } from "@/app/(app)/desk-context-actions"
import { unwrapAction } from "@/lib/action-result"
import type { SellableUnitDTO, UnitAvailability } from "@/lib/services/community-sales"
import { cn } from "@/lib/utils"

import { AgreementConfigurator } from "./agreement-configurator"
import {
  AVAILABILITY_BADGE,
  AVAILABILITY_BANDS,
  UNIT_TYPE_LABEL,
  formatCountdown,
  formatDay,
  money,
} from "./sales-format"
import { UnitSheet } from "./unit-sheet"

interface Option {
  id: string
  name: string
}

export interface UnitBoardScopeSummary {
  scopeUnits: number
  backlogUnits: number
  backlogValueCents: number
  closedUnitsYtd: number
  agingSpecs: number
}

export interface UnitBoardProps {
  units: SellableUnitDTO[]
  total: number
  page: number
  pageSize: number
  bandCounts: Record<UnitAvailability, number>
  summary: UnitBoardScopeSummary
  communities: Option[]
  divisions: Option[]
  plans: Option[]
  canManage: boolean
  /** Hide the community column + scope selects (mounted inside a single community). */
  embedded?: boolean
}

const AVAIL_SEGMENTS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "available", label: "Available" },
  { key: "held", label: "Held" },
  { key: "reserved", label: "Reserved" },
  { key: "sold", label: "Under contract" },
]

const BAND_ORDER: UnitAvailability[] = ["available", "held", "reserved", "sold", "closed"]

export function UnitBoard({
  units,
  total,
  page,
  pageSize,
  bandCounts,
  summary,
  communities,
  divisions,
  plans,
  canManage,
  embedded = false,
}: UnitBoardProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const activeUnitId = searchParams.get("unit")
  const writeMode = searchParams.get("write") === "1"
  const avail = searchParams.get("avail") ?? "all"
  const [search, setSearch] = useState(searchParams.get("q") ?? "")
  const [focusIndex, setFocusIndex] = useState(0)
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([])

  const setParams = useCallback(
    (mutate: (params: URLSearchParams) => void, options?: { context?: "division" | "community"; value?: string | null }) => {
      const params = new URLSearchParams(searchParams.toString())
      mutate(params)
      startTransition(async () => {
        if (options?.context === "division") await setDivisionContextAction(options.value ?? null)
        if (options?.context === "community") await setCommunityContextAction(options.value ?? null)
        router.push(`?${params.toString()}`)
      })
    },
    [router, searchParams, startTransition],
  )

  // Debounced server search
  useEffect(() => {
    const current = searchParams.get("q") ?? ""
    if (search === current) return
    const timer = setTimeout(() => {
      setParams((params) => {
        if (search.trim()) params.set("q", search.trim())
        else params.delete("q")
        params.delete("page")
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [search, searchParams, setParams])

  const visibleUnits = useMemo(
    () => (avail === "all" ? units : units.filter((unit) => (avail === "sold" ? unit.availability === "sold" || unit.availability === "closed" : unit.availability === avail))),
    [units, avail],
  )

  const grouped = useMemo(() => {
    const map = new Map<UnitAvailability, SellableUnitDTO[]>()
    for (const unit of visibleUnits) {
      const list = map.get(unit.availability) ?? []
      list.push(unit)
      map.set(unit.availability, list)
    }
    return BAND_ORDER.filter((band) => map.has(band)).map((band) => ({ band, units: map.get(band) ?? [] }))
  }, [visibleUnits])

  const flatUnits = useMemo(() => grouped.flatMap((group) => group.units), [grouped])

  const openUnit = useCallback(
    (lotId: string, write = false) => {
      setParams((params) => {
        params.set("unit", lotId)
        if (write) params.set("write", "1")
        else params.delete("write")
      })
    },
    [setParams],
  )

  const closeOverlay = useCallback(() => {
    setParams((params) => {
      params.delete("unit")
      params.delete("write")
    })
  }, [setParams])

  // Keyboard: j/k move, Enter open, / search, h/w act
  useEffect(() => {
    if (activeUnitId) return
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (target.closest("input, textarea, select, [contenteditable=true]")) {
        if (event.key === "Escape") (target as HTMLInputElement).blur()
        return
      }
      if (event.key === "/") {
        event.preventDefault()
        document.getElementById("unit-board-search")?.focus()
        return
      }
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault()
        setFocusIndex((index) => Math.min(index + 1, flatUnits.length - 1))
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault()
        setFocusIndex((index) => Math.max(index - 1, 0))
      } else if (event.key === "Enter") {
        const unit = flatUnits[focusIndex]
        if (unit) openUnit(unit.lotId)
      } else if ((event.key === "w" || event.key === "h") && canManage) {
        const unit = flatUnits[focusIndex]
        if (unit) openUnit(unit.lotId, event.key === "w")
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [activeUnitId, flatUnits, focusIndex, openUnit, canManage])

  useEffect(() => {
    rowRefs.current[focusIndex]?.scrollIntoView({ block: "nearest" })
  }, [focusIndex])

  const activeUnit = useMemo(() => units.find((unit) => unit.lotId === activeUnitId) ?? null, [units, activeUnitId])

  // "Needs you today" signals derived from the units on the board
  const attention = useMemo(() => {
    const now = Date.now()
    const soon = now + 48 * 3_600_000
    const expiring = units.filter((unit) => unit.availability === "held" && unit.reservationExpiresAt && Date.parse(unit.reservationExpiresAt) <= soon)
    const aging = units.filter((unit) => unit.availability === "available" && unit.agingDays >= 90)
    const unwritten = units.filter((unit) => unit.availability === "reserved" && !unit.contractId)
    return [
      { key: "held", count: expiring.length, label: `${expiring.length} hold${expiring.length === 1 ? "" : "s"} expiring ≤48h`, token: "var(--age-2)", filter: "held" },
      { key: "aging", count: aging.length, label: `${aging.length} available 90d+`, token: "var(--age-1)", filter: "available" },
      { key: "reserved", count: unwritten.length, label: `${unwritten.length} reserved · no contract`, token: "var(--primary)", filter: "reserved" },
    ].filter((chip) => chip.count > 0)
  }, [units])

  const firstPage = (page - 1) * pageSize
  const showingFrom = total === 0 ? 0 : firstPage + 1
  const showingTo = Math.min(firstPage + units.length, total)
  const hasFilters = Boolean(searchParams.get("q") || searchParams.get("plan") || searchParams.get("type") || (avail !== "all"))

  const nothingInScope = total === 0 && !hasFilters

  return (
    <div className="flex h-[calc(100vh-3.5rem-2.5rem)] flex-col">
      {/* Instrument header */}
      <div className="desk-rise shrink-0 px-4 py-3 sm:px-6">
        <p className="microlabel">Available to sell</p>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="font-mono text-4xl font-semibold tabular-nums tracking-tight sm:text-5xl">{bandCounts.available}</span>
          <p className="text-xs text-muted-foreground">
            {bandCounts.held} held · {bandCounts.reserved} reserved ·{" "}
            <span className="tabular-nums">{summary.backlogUnits}</span> in backlog{" "}
            <span className="tabular-nums">{money.format(summary.backlogValueCents / 100)}</span> ·{" "}
            <span className="tabular-nums">{summary.closedUnitsYtd}</span> closed YTD
            {summary.agingSpecs > 0 ? (
              <>
                {" · "}
                <span className="text-[var(--age-1)]">{summary.agingSpecs} aging spec{summary.agingSpecs === 1 ? "" : "s"}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      {/* Needs you today */}
      {attention.length > 0 ? (
        <div className="shrink-0 border-b px-4 py-2 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="microlabel">Needs you</span>
            {attention.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={() => setParams((params) => params.set("avail", chip.filter))}
                className="inline-flex items-center gap-1.5 border px-2 py-0.5 text-[11px] tabular-nums hover:bg-muted/60"
              >
                <span className="size-1.5" style={{ backgroundColor: chip.token }} />
                {chip.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Filter row */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5 sm:px-6">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="unit-board-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Lot or block"
            className="h-8 w-44 rounded-none pl-8 text-xs"
          />
        </div>
        <div className="flex items-center border">
          {AVAIL_SEGMENTS.map((segment) => (
            <button
              key={segment.key}
              type="button"
              onClick={() => setParams((params) => (segment.key === "all" ? params.delete("avail") : params.set("avail", segment.key)))}
              className={cn(
                "px-2.5 py-1 text-xs",
                avail === segment.key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {segment.label}
            </button>
          ))}
        </div>
        {!embedded && communities.length > 0 ? (
          <Select
            value={searchParams.get("community") ?? "all"}
            onValueChange={(value) => setParams((params) => {
              if (value === "all") params.delete("community")
              else params.set("community", value)
              params.delete("page")
            }, { context: "community", value: value === "all" ? null : value })}
          >
            <SelectTrigger className="h-8 w-44 rounded-none text-xs"><SelectValue placeholder="All communities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All communities</SelectItem>
              {communities.map((community) => <SelectItem key={community.id} value={community.id}>{community.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        {!embedded && divisions.length > 0 ? (
          <Select
            value={searchParams.get("division") ?? "all"}
            onValueChange={(value) => setParams((params) => {
              if (value === "all") params.delete("division")
              else params.set("division", value)
              params.delete("community")
              params.delete("page")
            }, { context: "division", value: value === "all" ? null : value })}
          >
            <SelectTrigger className="h-8 w-40 rounded-none text-xs"><SelectValue placeholder="All divisions" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All divisions</SelectItem>
              {divisions.map((division) => <SelectItem key={division.id} value={division.id}>{division.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        {plans.length > 0 ? (
          <Select
            value={searchParams.get("plan") ?? "all"}
            onValueChange={(value) => setParams((params) => {
              if (value === "all") params.delete("plan")
              else params.set("plan", value)
              params.delete("page")
            })}
          >
            <SelectTrigger className="h-8 w-36 rounded-none text-xs"><SelectValue placeholder="All plans" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plans</SelectItem>
              {plans.map((plan) => <SelectItem key={plan.id} value={plan.id}>{plan.name}</SelectItem>)}
            </SelectContent>
          </Select>
        ) : null}
        <Select
          value={searchParams.get("type") ?? "all"}
          onValueChange={(value) => setParams((params) => {
            if (value === "all") params.delete("type")
            else params.set("type", value)
            params.delete("page")
          })}
        >
          <SelectTrigger className="h-8 w-28 rounded-none text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any type</SelectItem>
            <SelectItem value="spec">Spec</SelectItem>
            <SelectItem value="tbb">To-be-built</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{visibleUnits.length} shown</span>
          {canManage ? (
            <Button
              size="sm"
              className="h-8 rounded-none"
              disabled={units.length === 0}
              onClick={() => {
                const target = flatUnits.find((unit) => unit.availability === "available") ?? flatUnits[0]
                if (target) openUnit(target.lotId)
              }}
            >
              <Plus className="mr-1 size-3.5" /> Hold a lot
            </Button>
          ) : null}
        </div>
      </div>

      {/* Table */}
      <div className={cn("min-h-0 flex-1 overflow-auto", pending && "opacity-60")}>
        {nothingInScope ? (
          <BoardEmpty
            title="No sellable units yet"
            hint="Lots become sellable the moment they're developed. Add a community with lots to start."
            action={{ href: "/communities", label: "Go to Communities" }}
          />
        ) : visibleUnits.length === 0 ? (
          <BoardEmpty
            title="No units match"
            hint="Clear the filters or widen the community scope."
            action={{ onClick: () => setParams((params) => { params.delete("q"); params.delete("plan"); params.delete("type"); params.delete("avail"); setSearch("") }), label: "Clear filters" }}
          />
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10">
              <tr>
                {(embedded ? UNIT_HEAD.filter((head) => head.key !== "unit") : UNIT_HEAD).map((head) => (
                  <th
                    key={head.key}
                    className={cn(
                      "microlabel sticky top-0 z-10 border-b bg-card px-3 py-2.5 whitespace-nowrap",
                      head.align === "right" ? "text-right" : "text-left",
                    )}
                  >
                    {head.label}
                  </th>
                ))}
                <th className="sticky top-0 z-10 border-b bg-card px-3 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {grouped.map((group) => {
                const meta = AVAILABILITY_BANDS[group.band]
                const value = group.units.reduce((sum, unit) => sum + unit.askingPriceCents, 0)
                return (
                  <BandRows
                    key={group.band}
                    meta={meta}
                    value={value}
                    units={group.units}
                    embedded={embedded}
                    focusLotId={flatUnits[focusIndex]?.lotId ?? null}
                    onOpen={openUnit}
                    onFocus={(lotId) => setFocusIndex(flatUnits.findIndex((unit) => unit.lotId === lotId))}
                    canManage={canManage}
                    registerRef={(lotId, node) => {
                      const index = flatUnits.findIndex((unit) => unit.lotId === lotId)
                      if (index >= 0) rowRefs.current[index] = node
                    }}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      {total > 0 ? (
        <div className="flex shrink-0 items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">
          <span className="tabular-nums">Showing {showingFrom}–{showingTo} of {total}</span>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 rounded-none" disabled={page <= 1 || pending} onClick={() => setParams((params) => params.set("page", String(page - 1)))}>Previous</Button>
            <Button variant="outline" size="sm" className="h-7 rounded-none" disabled={showingTo >= total || pending} onClick={() => setParams((params) => params.set("page", String(page + 1)))}>Next</Button>
          </div>
        </div>
      ) : null}

      {activeUnitId && !writeMode ? (
        <UnitSheet lotId={activeUnitId} fallback={activeUnit} canManage={canManage} onClose={closeOverlay} onWrite={() => openUnit(activeUnitId, true)} />
      ) : null}
      {activeUnitId && writeMode ? (
        <AgreementConfigurator lotId={activeUnitId} onClose={() => openUnit(activeUnitId)} />
      ) : null}
    </div>
  )
}

const UNIT_HEAD: { key: string; label: string; align?: "right" }[] = [
  { key: "unit", label: "Unit" },
  { key: "plan", label: "Plan" },
  { key: "type", label: "Type" },
  { key: "ready", label: "Ready" },
  { key: "days", label: "Days", align: "right" },
  { key: "list", label: "List", align: "right" },
  { key: "asking", label: "Asking", align: "right" },
  { key: "status", label: "Status" },
  { key: "buyer", label: "Buyer" },
]

function BandRows({
  meta,
  value,
  units,
  embedded,
  focusLotId,
  onOpen,
  onFocus,
  registerRef,
}: {
  meta: (typeof AVAILABILITY_BANDS)[UnitAvailability]
  value: number
  units: SellableUnitDTO[]
  embedded: boolean
  focusLotId: string | null
  onOpen: (lotId: string) => void
  onFocus: (lotId: string) => void
  canManage: boolean
  registerRef: (lotId: string, node: HTMLTableRowElement | null) => void
}) {
  const colSpan = (embedded ? 9 : 10)
  return (
    <>
      <tr className="bg-muted/60">
        <td colSpan={colSpan} className="px-3 py-1.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2">
              <span className="size-2" style={{ backgroundColor: meta.swatch }} />
              <span className="text-[11px] font-semibold uppercase tracking-wide">{meta.label}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">{units.length}</span>
            </span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{money.format(value / 100)}</span>
          </div>
        </td>
      </tr>
      {units.map((unit) => (
        <UnitRow
          key={unit.lotId}
          unit={unit}
          embedded={embedded}
          focused={focusLotId === unit.lotId}
          onOpen={onOpen}
          onFocus={onFocus}
          registerRef={registerRef}
        />
      ))}
    </>
  )
}

function UnitRow({
  unit,
  embedded,
  focused,
  onOpen,
  onFocus,
  registerRef,
}: {
  unit: SellableUnitDTO
  embedded: boolean
  focused: boolean
  onOpen: (lotId: string) => void
  onFocus: (lotId: string) => void
  registerRef: (lotId: string, node: HTMLTableRowElement | null) => void
}) {
  const countdown = unit.availability === "held" ? formatCountdown(unit.reservationExpiresAt) : null
  const cut = unit.askingOverrideCents != null && unit.askingOverrideCents < unit.listPriceCents
  const cutPct = cut && unit.listPriceCents > 0 ? ((unit.askingOverrideCents! - unit.listPriceCents) / unit.listPriceCents) * 100 : 0
  const agingClass = unit.agingDays >= 90 ? "text-[var(--age-2)] font-medium" : unit.agingDays >= 60 ? "text-[var(--age-1)]" : "text-muted-foreground"

  return (
    <tr
      ref={(node) => registerRef(unit.lotId, node)}
      onClick={() => onOpen(unit.lotId)}
      onMouseEnter={() => onFocus(unit.lotId)}
      className={cn("cursor-pointer border-b hover:bg-muted/40", focused && "bg-muted/40")}
    >
      {!embedded ? (
        <td className="px-3 py-2.5">
          <div className="font-medium">{unit.communityName ?? "Community"} · Lot {unit.lotLabel}</div>
          <div className="text-xs text-muted-foreground">{[unit.block ? `Block ${unit.block}` : null, unit.phaseName].filter(Boolean).join(" · ") || "—"}</div>
        </td>
      ) : null}
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-1.5">{unit.planLabel ?? "Unassigned"}{unit.availability === "sold" ? <Lock className="size-3 text-muted-foreground" /> : null}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {[unit.beds != null ? `${unit.beds}bd` : null, unit.baths != null ? `${unit.baths}ba` : null, unit.heatedSqft != null ? `${unit.heatedSqft.toLocaleString()} sf` : null].filter(Boolean).join(" · ") || (unit.swing !== "either" ? `${unit.swing} swing` : "—")}
        </div>
      </td>
      <td className="px-3 py-2.5 text-[10px] uppercase tracking-wide text-muted-foreground">{UNIT_TYPE_LABEL[unit.unitType]}</td>
      <td className="px-3 py-2.5 text-xs tabular-nums text-muted-foreground">{unit.projectedCloseDate ? formatDay(unit.projectedCloseDate) : unit.startedAt ? "In build" : "—"}</td>
      <td className={cn("px-3 py-2.5 text-right tabular-nums", agingClass)}>{unit.agingDays}d</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">{unit.listPriceCents > 0 ? money.format(unit.listPriceCents / 100) : "—"}</td>
      <td className="px-3 py-2.5 text-right">
        <div className="font-medium tabular-nums">{unit.askingPriceCents > 0 ? money.format(unit.askingPriceCents / 100) : "—"}</div>
        {cut ? (
          <div className="text-[11px] tabular-nums text-[var(--age-2)]">
            <span className="text-muted-foreground line-through">{money.format(unit.listPriceCents / 100)}</span> {cutPct.toFixed(1)}%
          </div>
        ) : null}
      </td>
      <td className="px-3 py-2.5">
        <Badge variant="outline" className={cn("rounded-none text-[10px] uppercase tracking-wide", AVAILABILITY_BADGE[unit.availability])}>
          {countdown ? countdown.label : AVAILABILITY_BANDS[unit.availability].label}
        </Badge>
      </td>
      <td className="px-3 py-2.5">
        <span className="text-xs">{unit.buyerName ?? <span className="text-muted-foreground">—</span>}</span>
      </td>
      <td className="px-2 py-2.5 text-right"><ChevronRight className="ml-auto size-4 text-muted-foreground" /></td>
    </tr>
  )
}

function BoardEmpty({
  title,
  hint,
  action,
}: {
  title: string
  hint: string
  action?: { href?: string; onClick?: () => void; label: string }
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 px-4 py-20 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>
      {action ? (
        action.href ? (
          <Link href={action.href} className="mt-1 text-xs font-medium underline underline-offset-2 hover:text-primary">{action.label}</Link>
        ) : (
          <button type="button" onClick={action.onClick} className="mt-1 text-xs font-medium underline underline-offset-2 hover:text-primary">{action.label}</button>
        )
      ) : null}
    </div>
  )
}
