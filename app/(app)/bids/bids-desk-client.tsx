"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { addDays, differenceInCalendarDays, format, startOfDay } from "date-fns"

import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Gavel } from "@/components/icons"
import { cn, formatMoneyCents } from "@/lib/utils"
import type { OrgBidPackage } from "@/lib/services/bids"
import type { BidPackageStage } from "@/lib/bids/stage"

type DeskPackage = OrgBidPackage & { stage: BidPackageStage }

interface BidsDeskClientProps {
  packages: DeskPackage[]
  tradeOptions: string[]
}

const ALL_TRADES = "__all_trades__"
const ALL_STAGES = "__all_stages__"

// Urgency bands the single table groups by. Order = descending urgency.
type Band = "due_this_week" | "ready_to_award" | "leveling" | "open" | "recently_awarded"

const BAND_META: Record<Band, { label: string; hint: string; color: string }> = {
  due_this_week: { label: "Due this week", hint: "Deadlines land in the next 7 days", color: "var(--age-1)" },
  ready_to_award: { label: "Ready to award", hint: "Closed with bids in hand", color: "var(--age-0)" },
  leveling: { label: "Leveling", hint: "Closed or past due, awaiting bids", color: "var(--age-2)" },
  open: { label: "Open", hint: "Out for bid", color: "var(--muted-foreground)" },
  recently_awarded: { label: "Recently awarded", hint: "Bought out in the last 14 days", color: "var(--success)" },
}

const BAND_ORDER: Band[] = ["due_this_week", "ready_to_award", "leveling", "open", "recently_awarded"]

const STAGE_META: Record<BidPackageStage, { label: string; color: string }> = {
  setup: { label: "Setup", color: "var(--muted-foreground)" },
  bidding: { label: "Bidding", color: "var(--age-0)" },
  leveling: { label: "Leveling", color: "var(--age-2)" },
  awarded: { label: "Awarded", color: "var(--success)" },
  cancelled: { label: "Cancelled", color: "var(--muted-foreground)" },
}

const STAGE_FILTER_OPTIONS: BidPackageStage[] = ["setup", "bidding", "leveling", "awarded"]

function bandFor(pkg: DeskPackage, today: Date): Band | null {
  if (pkg.stage === "awarded") {
    const awardedAt = pkg.updated_at ?? pkg.created_at
    if (awardedAt && differenceInCalendarDays(today, startOfDay(new Date(awardedAt))) <= 14) {
      return "recently_awarded"
    }
    return null // older awards drop off the bid-day view
  }
  if (pkg.stage === "leveling") {
    return (pkg.response_count ?? 0) >= 1 ? "ready_to_award" : "leveling"
  }
  // setup / bidding
  if (pkg.due_at) {
    const days = differenceInCalendarDays(startOfDay(new Date(pkg.due_at)), today)
    if (days >= 0 && days <= 7) return "due_this_week"
  }
  return "open"
}

function jobHref(pkg: DeskPackage): string | null {
  if (pkg.project_id) return `/projects/${pkg.project_id}/bids/${pkg.id}`
  if (pkg.prospect_id) return `/pipeline/prospects/${pkg.prospect_id}/bids/${pkg.id}`
  return null
}

function formatDueAbsolute(dueAt: string, tz?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(tz ? { timeZone: tz, timeZoneName: "short" } : {}),
    }).format(new Date(dueAt))
  } catch {
    return format(new Date(dueAt), "MMM d, h:mm a")
  }
}

function formatDueRelative(dueAt: string, today: Date): { text: string; overdue: boolean } {
  const days = differenceInCalendarDays(startOfDay(new Date(dueAt)), today)
  if (days < 0) return { text: `${Math.abs(days)}d overdue`, overdue: true }
  if (days === 0) return { text: "Today", overdue: false }
  if (days === 1) return { text: "Tomorrow", overdue: false }
  return { text: `in ${days}d`, overdue: false }
}

/** A tiny inline coverage bar: responses over invited. */
function CoverageBar({ responses, invited }: { responses: number; invited: number }) {
  const pct = invited > 0 ? Math.min(100, Math.round((responses / invited) * 100)) : 0
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-xs tabular-nums text-foreground">
        {responses}
        <span className="text-muted-foreground">/{invited}</span>
      </span>
      <span className="h-1.5 w-16 overflow-hidden bg-muted" aria-hidden>
        <span
          className="block h-full"
          style={{ width: `${pct}%`, backgroundColor: invited > 0 && responses >= invited ? "var(--success)" : "var(--age-0)" }}
        />
      </span>
    </div>
  )
}

function StageBadge({ stage }: { stage: BidPackageStage }) {
  const meta = STAGE_META[stage]
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span className="size-1.5" style={{ backgroundColor: meta.color }} />
      <span className="text-foreground">{meta.label}</span>
    </span>
  )
}

export function BidsDeskClient({ packages, tradeOptions }: BidsDeskClientProps) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [tradeFilter, setTradeFilter] = useState(ALL_TRADES)
  const [stageFilter, setStageFilter] = useState(ALL_STAGES)

  const today = useMemo(() => startOfDay(new Date()), [])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return packages.filter((pkg) => {
      if (tradeFilter !== ALL_TRADES && pkg.trade?.trim() !== tradeFilter) return false
      if (stageFilter !== ALL_STAGES && pkg.stage !== stageFilter) return false
      if (term) {
        const haystack = [pkg.title, pkg.trade, pkg.job_name, pkg.scope]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
        if (!haystack.includes(term)) return false
      }
      return true
    })
  }, [packages, search, tradeFilter, stageFilter])

  // 14-day due-date strip built from every visible package with a deadline.
  const weekStrip = useMemo(() => {
    const days = Array.from({ length: 14 }, (_, i) => addDays(today, i))
    return days.map((day) => {
      const due = filtered.filter(
        (pkg) =>
          pkg.due_at &&
          pkg.stage !== "awarded" &&
          differenceInCalendarDays(startOfDay(new Date(pkg.due_at)), day) === 0,
      )
      const trades = [
        ...new Set(due.map((pkg) => pkg.trade?.trim()).filter((t): t is string => Boolean(t))),
      ]
      return { day, count: due.length, trades }
    })
  }, [filtered, today])

  const hasStripActivity = weekStrip.some((cell) => cell.count > 0)

  const banded = useMemo(() => {
    const map = new Map<Band, DeskPackage[]>()
    for (const pkg of filtered) {
      const band = bandFor(pkg, today)
      if (!band) continue
      const list = map.get(band)
      if (list) list.push(pkg)
      else map.set(band, [pkg])
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        const ad = a.due_at ? new Date(a.due_at).getTime() : Number.MAX_SAFE_INTEGER
        const bd = b.due_at ? new Date(b.due_at).getTime() : Number.MAX_SAFE_INTEGER
        return ad - bd
      })
    }
    return map
  }, [filtered, today])

  const visibleCount = BAND_ORDER.reduce((sum, band) => sum + (banded.get(band)?.length ?? 0), 0)

  if (packages.length === 0) {
    return (
      <div className="flex h-[calc(100vh-56px)] flex-col items-center justify-center gap-3 p-8 text-center">
        <Gavel className="size-10 text-muted-foreground/50" />
        <h2 className="text-lg font-semibold">No bid packages yet</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Bid packages live on projects — start one from a project&apos;s Bids tab or straight from
          its budget. They&apos;ll show up here across every job.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col overflow-hidden">
      {/* Week strip — bid-day situational awareness, one quiet row */}
      <div className="shrink-0 border-b px-4 py-3 sm:px-6">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>Next 14 days</span>
          {!hasStripActivity ? <span className="font-normal normal-case">— nothing due</span> : null}
        </div>
        <div className="flex gap-1 overflow-x-auto pb-1">
          {weekStrip.map((cell) => {
            const isToday = differenceInCalendarDays(cell.day, today) === 0
            return (
              <div
                key={cell.day.getTime()}
                className={cn(
                  "flex min-w-[64px] flex-1 flex-col gap-1 border p-1.5",
                  cell.count > 0 ? "bg-muted/40" : "bg-background",
                  isToday && "border-foreground/40",
                )}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {format(cell.day, "EEE")}
                  </span>
                  <span
                    className={cn(
                      "font-mono text-[11px] tabular-nums",
                      isToday ? "font-semibold text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {format(cell.day, "d")}
                  </span>
                </div>
                {cell.count > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
                      {cell.count}
                    </span>
                    <div className="flex flex-wrap gap-0.5">
                      {cell.trades.slice(0, 2).map((trade) => (
                        <span
                          key={trade}
                          className="max-w-full truncate border px-1 text-[9px] leading-tight text-muted-foreground"
                          title={trade}
                        >
                          {trade}
                        </span>
                      ))}
                      {cell.trades.length > 2 ? (
                        <span className="text-[9px] text-muted-foreground">+{cell.trades.length - 2}</span>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <span className="text-[10px] text-muted-foreground/40">—</span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="shrink-0 border-b px-4 py-2.5 sm:px-6">
        <div className="grid gap-2 sm:grid-cols-[minmax(200px,1fr)_180px_180px]">
          <Input
            placeholder="Search packages…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select value={tradeFilter} onValueChange={setTradeFilter}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Trade" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TRADES}>All trades</SelectItem>
              {tradeOptions.map((trade) => (
                <SelectItem key={trade} value={trade}>
                  {trade}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={stageFilter} onValueChange={setStageFilter}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Stage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STAGES}>All stages</SelectItem>
              {STAGE_FILTER_OPTIONS.map((stage) => (
                <SelectItem key={stage} value={stage}>
                  {STAGE_META[stage].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* The single dense table, grouped by urgency band */}
      <div className="min-h-0 flex-1 overflow-auto">
        {visibleCount === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
            <p className="text-sm font-medium text-foreground">No packages match</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Clear the search or filters to see the full bid board.
            </p>
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium sm:px-6">Package</th>
                <th className="px-4 py-2 font-medium">Job</th>
                <th className="px-4 py-2 font-medium">Coverage</th>
                <th className="px-4 py-2 text-right font-medium">Low bid</th>
                <th className="px-4 py-2 font-medium">Due</th>
                <th className="px-4 py-2 font-medium">Stage</th>
              </tr>
            </thead>
            <tbody>
              {BAND_ORDER.map((band) => {
                const rows = banded.get(band)
                if (!rows || rows.length === 0) return null
                const meta = BAND_META[band]
                return (
                  <BandGroup key={band} meta={meta} rows={rows} today={today} onOpen={(href) => router.push(href)} />
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function BandGroup({
  meta,
  rows,
  today,
  onOpen,
}: {
  meta: { label: string; hint: string; color: string }
  rows: DeskPackage[]
  today: Date
  onOpen: (href: string) => void
}) {
  return (
    <>
      <tr className="bg-muted/60">
        <td colSpan={6} className="px-4 py-1.5 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="size-2" style={{ backgroundColor: meta.color }} />
            <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
              {meta.label}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{rows.length}</span>
            <span className="text-[11px] text-muted-foreground/70">· {meta.hint}</span>
          </div>
        </td>
      </tr>
      {rows.map((pkg) => {
        const href = jobHref(pkg)
        const due = pkg.due_at ? formatDueRelative(pkg.due_at, today) : null
        return (
          <tr
            key={pkg.id}
            className={cn(
              "border-b transition-colors",
              href ? "cursor-pointer hover:bg-muted/40" : "opacity-70",
            )}
            onClick={href ? () => onOpen(href) : undefined}
          >
            <td className="px-4 py-2.5 sm:px-6">
              <div className="font-medium text-foreground">{pkg.title}</div>
              {pkg.trade ? <div className="text-xs text-muted-foreground">{pkg.trade}</div> : null}
            </td>
            <td className="px-4 py-2.5">
              {pkg.job_name ? (
                <span className="text-foreground">{pkg.job_name}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
              {pkg.job_kind === "prospect" ? (
                <span className="ml-1.5 border px-1 text-[9px] uppercase tracking-wide text-muted-foreground">
                  prospect
                </span>
              ) : null}
            </td>
            <td className="px-4 py-2.5">
              <CoverageBar responses={pkg.response_count ?? 0} invited={pkg.invite_count ?? 0} />
            </td>
            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
              {pkg.lowest_bid_cents != null ? (
                <span className="text-foreground">{formatMoneyCents(pkg.lowest_bid_cents)}</span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </td>
            <td className="px-4 py-2.5">
              {pkg.due_at && due ? (
                <div className="leading-tight">
                  <div className={cn("text-xs font-medium", due.overdue ? "text-[var(--age-2)]" : "text-foreground")}>
                    {due.text}
                  </div>
                  <div className="text-[11px] text-muted-foreground">{formatDueAbsolute(pkg.due_at, pkg.due_tz)}</div>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">No deadline</span>
              )}
            </td>
            <td className="px-4 py-2.5">
              <StageBadge stage={pkg.stage} />
            </td>
          </tr>
        )
      })}
    </>
  )
}
