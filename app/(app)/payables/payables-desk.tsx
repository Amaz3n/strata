"use client"

import Link from "next/link"
import * as React from "react"

import { ArrowUpRight, Check, X } from "@/components/icons"
import type { OrgPayablesDeskData, PayableQueueRow } from "@/lib/services/org-payables"
import { cn } from "@/lib/utils"

function money(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function shortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(
    new Date(`${value}T00:00:00`),
  )
}

type WindowKey = "overdue" | "thisWeek" | "soon" | "later"

/** Mirror of the server's horizon-bucketing so a clicked bar filters the queue. */
function bucketOf(row: PayableQueueRow): WindowKey {
  const { dueDate, daysToDue } = row
  if (dueDate == null || (daysToDue != null && daysToDue > 30)) return "later"
  if (daysToDue != null && daysToDue < 0) return "overdue"
  if (daysToDue != null && daysToDue <= 7) return "thisWeek"
  return "soon"
}

const WINDOWS: { key: WindowKey; label: string; barClass: string; late: boolean }[] = [
  { key: "overdue", label: "Overdue", barClass: "bg-destructive", late: true },
  { key: "thisWeek", label: "This week", barClass: "bg-primary", late: false },
  { key: "soon", label: "8–30 days", barClass: "bg-primary/40", late: false },
  { key: "later", label: "31+ days", barClass: "bg-muted-foreground/25", late: false },
]

function statusChip(row: PayableQueueRow): { label: string; live: boolean } {
  if (row.partiallyPaid) return { label: "Partly paid", live: true }
  if (row.status === "approved") return { label: "Approved", live: true }
  return { label: row.status, live: false }
}

function dueLines(row: PayableQueueRow): { date: string; rel: string | null; tone: "late" | "soon" | "muted" } {
  if (row.dueDate == null) return { date: "No due date", rel: null, tone: "muted" }
  const date = shortDate(row.dueDate)
  const d = row.daysToDue
  if (d == null) return { date, rel: null, tone: "muted" }
  if (d < 0) return { date, rel: `${-d}d overdue`, tone: "late" }
  if (d === 0) return { date, rel: "Due today", tone: "soon" }
  if (d === 1) return { date, rel: "Due tomorrow", tone: "soon" }
  if (d <= 7) return { date, rel: `In ${d} days`, tone: "soon" }
  return { date, rel: `In ${d} days`, tone: "muted" }
}

/**
 * Bounded scroll region with a bottom shadow that fades in while more content
 * sits below the fold — the affordance that says "keep scrolling."
 */
function ScrollRegion({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [edges, setEdges] = React.useState({ top: false, bottom: false })

  const update = React.useCallback(() => {
    const el = ref.current
    if (!el) return
    const top = el.scrollTop > 1
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1
    setEdges((prev) => (prev.top === top && prev.bottom === bottom ? prev : { top, bottom }))
  }, [])

  React.useEffect(() => {
    const el = ref.current
    if (!el) return
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => observer.disconnect()
  }, [update])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={update} className={cn("h-full overflow-y-auto", className)}>
        {children}
      </div>
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-3 transition-opacity duration-200",
          edges.top ? "opacity-100" : "opacity-0",
        )}
        style={{ boxShadow: "inset 0 7px 6px -6px color-mix(in oklab, var(--foreground) 20%, transparent)" }}
      />
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-4 transition-opacity duration-200",
          edges.bottom ? "opacity-100" : "opacity-0",
        )}
        style={{ boxShadow: "inset 0 -10px 8px -7px color-mix(in oklab, var(--foreground) 22%, transparent)" }}
      />
    </div>
  )
}

const TH = "microlabel sticky top-0 z-10 bg-card border-b px-4 py-2.5 text-left whitespace-nowrap"

export function PayablesDesk({ data }: { data: OrgPayablesDeskData }) {
  const { stats, horizon, queue, vendors, inboundBillsEmail } = data
  const [filter, setFilter] = React.useState<WindowKey | null>(null)

  const allClear = stats.openCount === 0

  const maxBucket = Math.max(1, ...WINDOWS.map((w) => horizon[w.key].cents))
  const barHeight = (cents: number) => (cents === 0 ? 0 : Math.max(6, Math.round((cents / maxBucket) * 100)))

  const visibleQueue = React.useMemo(
    () => (filter ? queue.filter((row) => bucketOf(row) === filter) : queue),
    [queue, filter],
  )
  const activeWindow = filter ? WINDOWS.find((w) => w.key === filter) ?? null : null

  const maxVendor = Math.max(1, vendors[0]?.outstandingCents ?? 0)

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pb-6 pt-6 sm:px-6 lg:h-full lg:min-h-0 lg:gap-5 lg:pb-4 lg:px-8">
      {/* ── Header: the total owed ─────────────────────────────── */}
      <header className="desk-rise" style={{ "--desk-stagger": 0 } as React.CSSProperties}>
        <div className="microlabel">Owed to vendors</div>
        <div className="mt-1.5 font-mono text-4xl tabular-nums tracking-tight sm:text-5xl">
          {money(stats.outstandingCents)}
        </div>
        {stats.retainedCents > 0 || stats.pendingApprovalCount > 0 || inboundBillsEmail ? (
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            {stats.pendingApprovalCount > 0 ? (
              <span>
                <span className="font-mono font-medium tabular-nums text-warning">{money(stats.pendingApprovalCents)}</span>{" "}
                awaiting approval · {stats.pendingApprovalCount} {stats.pendingApprovalCount === 1 ? "bill" : "bills"}
              </span>
            ) : null}
            {stats.retainedCents > 0 ? (
              <span>
                <span className="font-mono font-medium tabular-nums text-foreground">{money(stats.retainedCents)}</span>{" "}
                retention held
              </span>
            ) : null}
            {inboundBillsEmail ? (
              <span>
                Vendors can email bills to{" "}
                <button
                  type="button"
                  className="font-mono font-medium text-foreground underline-offset-2 hover:underline"
                  title="Copy address"
                  onClick={() => void navigator.clipboard.writeText(inboundBillsEmail)}
                >
                  {inboundBillsEmail}
                </button>
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      {allClear ? (
        <div
          className="desk-rise flex items-center gap-2.5 border bg-card px-4 py-3 text-sm text-muted-foreground"
          style={{ "--desk-stagger": 1 } as React.CSSProperties}
        >
          <Check className="h-4 w-4 text-success" />
          You&rsquo;re all caught up — no open payables anywhere.
        </div>
      ) : (
        <>
          {/* ── Aging: a contained panel of clickable outflow windows ── */}
          <section
            className="desk-rise border bg-card p-4 sm:p-5"
            style={{ "--desk-stagger": 1 } as React.CSSProperties}
          >
            <div className="mb-4 flex items-baseline justify-between">
              <div className="microlabel">Aging</div>
              {filter ? (
                <button
                  type="button"
                  onClick={() => setFilter(null)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear filter
                  <X className="size-3" />
                </button>
              ) : (
                <div className="text-[11px] text-muted-foreground">Select a window to filter</div>
              )}
            </div>

            <div className="relative grid grid-cols-4 gap-2 sm:gap-3">
              {WINDOWS.map((w) => {
                const bucket = horizon[w.key]
                const active = filter === w.key
                const dimmed = filter != null && !active
                return (
                  <button
                    type="button"
                    key={w.key}
                    aria-pressed={active}
                    disabled={bucket.count === 0}
                    onClick={() => setFilter((prev) => (prev === w.key ? null : w.key))}
                    className={cn(
                      "group/bar flex flex-col items-stretch gap-2 border px-2 py-2.5 text-left transition-all sm:px-3",
                      active ? "border-foreground bg-muted/50" : "border-transparent hover:bg-muted/40",
                      dimmed && "opacity-45",
                      bucket.count === 0 && "cursor-default opacity-40 hover:bg-transparent",
                    )}
                  >
                    <div className="flex h-20 items-end sm:h-24">
                      <div
                        className={cn("w-full min-h-[3px] transition-all", w.barClass)}
                        style={{ height: `${barHeight(bucket.cents)}%` }}
                      />
                    </div>
                    <div className="border-t pt-2">
                      <div className={cn("microlabel text-[9.5px]", w.late && "text-destructive")}>{w.label}</div>
                      <div
                        className={cn(
                          "mt-1 font-mono text-sm font-medium tabular-nums sm:text-base",
                          w.late && "text-destructive",
                        )}
                      >
                        {money(bucket.cents)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {bucket.count} {bucket.count === 1 ? "bill" : "bills"}
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </section>

          {/* ── Tables: fixed-height, each scrolls within itself ────── */}
          <div className="grid grid-cols-1 items-stretch gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[2fr_1fr] lg:gap-5">
            <section
              className="desk-rise flex min-h-0 flex-col overflow-hidden border bg-card max-lg:max-h-[70vh]"
              style={{ "--desk-stagger": 2 } as React.CSSProperties}
            >
              <header className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
                <h2 className="text-sm font-semibold">
                  Coming due
                  {activeWindow ? (
                    <span className="ml-2 font-normal text-muted-foreground">· {activeWindow.label}</span>
                  ) : null}
                </h2>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {activeWindow
                    ? `${visibleQueue.length} ${visibleQueue.length === 1 ? "bill" : "bills"}`
                    : stats.overdueCount > 0
                      ? `${stats.overdueCount} overdue · ${stats.dueThisWeekCount} this week`
                      : `${stats.dueThisWeekCount} this week`}
                </div>
              </header>
              {visibleQueue.length === 0 ? (
                <div className="flex flex-1 items-center justify-center px-4 py-10 text-sm text-muted-foreground">
                  No bills in this window.
                </div>
              ) : (
                <ScrollRegion>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={TH}>Vendor</th>
                        <th className={TH}>Project</th>
                        <th className={TH}>Due</th>
                        <th className={cn(TH, "text-right")}>Outstanding</th>
                        <th aria-hidden className="sticky top-0 z-10 bg-card border-b" />
                      </tr>
                    </thead>
                    <tbody>
                      {visibleQueue.map((row) => {
                        const due = dueLines(row)
                        const chip = statusChip(row)
                        return (
                          <tr
                            key={row.id}
                            className="group relative cursor-pointer border-b transition-colors last:border-b-0 hover:bg-muted/40"
                          >
                            <td className="px-4 py-3">
                              <Link
                                href={row.href}
                                className="text-sm font-medium underline-offset-4 after:absolute after:inset-0 group-hover:underline"
                              >
                                {row.vendorName}
                              </Link>
                              <div className="mt-1">
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1.5 rounded-full border px-2 py-px text-[11px] font-medium capitalize text-muted-foreground",
                                    chip.live && "border-primary/30 text-primary",
                                  )}
                                >
                                  <span className="size-[5px] rounded-full bg-current" />
                                  {chip.label}
                                </span>
                              </div>
                            </td>
                            <td className="px-4 py-3 text-xs text-muted-foreground">{row.projectName}</td>
                            <td className="px-4 py-3">
                              <div className="text-sm tabular-nums">{due.date}</div>
                              {due.rel ? (
                                <div
                                  className={cn(
                                    "mt-0.5 text-[11px]",
                                    due.tone === "late"
                                      ? "font-medium text-destructive"
                                      : due.tone === "soon"
                                        ? "font-medium text-primary"
                                        : "text-muted-foreground",
                                  )}
                                >
                                  {due.rel}
                                </div>
                              ) : null}
                            </td>
                            <td className="px-4 py-3 text-right font-mono text-sm font-medium tabular-nums">
                              {money(row.outstandingCents)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              <ArrowUpRight className="inline-block size-4 text-muted-foreground/40 transition-colors group-hover:text-foreground" />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}
            </section>

            <section
              className="desk-rise flex min-h-0 flex-col overflow-hidden border bg-card max-lg:max-h-[60vh]"
              style={{ "--desk-stagger": 3 } as React.CSSProperties}
            >
              <header className="flex items-baseline justify-between gap-3 border-b px-4 py-2.5">
                <h2 className="text-sm font-semibold">Who you owe</h2>
                <div className="text-xs tabular-nums text-muted-foreground">{stats.vendorCount}</div>
              </header>
              <ScrollRegion>
                {vendors.map((v) => (
                  <div className="flex flex-col gap-1.5 border-b px-4 py-3 last:border-b-0" key={v.vendorName}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">{v.vendorName}</span>
                      <span className="font-mono text-sm font-medium tabular-nums">{money(v.outstandingCents)}</span>
                    </div>
                    <div className="h-1 overflow-hidden bg-border">
                      <div
                        className={cn("h-full", v.hasOverdue ? "bg-destructive" : "bg-primary")}
                        style={{ width: `${Math.max(4, Math.round((v.outstandingCents / maxVendor) * 100))}%` }}
                      />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {v.openCount} open {v.openCount === 1 ? "bill" : "bills"}
                      {v.hasOverdue ? " · has overdue" : v.nextDueDate ? ` · next ${shortDate(v.nextDueDate)}` : ""}
                    </div>
                  </div>
                ))}
              </ScrollRegion>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
