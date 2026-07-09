import Link from "next/link"
import {
  differenceInCalendarDays,
  eachDayOfInterval,
  eachMonthOfInterval,
  eachWeekOfInterval,
  endOfMonth,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns"
import { Flag } from "lucide-react"

import { PageLayout } from "@/components/layout/page-layout"
import { Button } from "@/components/ui/button"
import { CalendarDays, ChevronRight } from "@/components/icons"
import { MarkScheduleItemCompleteButton } from "@/components/schedule/mark-complete-button"
import { parseDate } from "@/components/schedule/types"
import { cn } from "@/lib/utils"
import type { Project, ScheduleItem } from "@/lib/types"

import { listProjectsAction } from "../projects/actions"
import { listScheduleItemsAction } from "./actions"
import { GanttScrollArea } from "./gantt-scroll-area"
// Share the project Gantt's marks (bars, milestones, today line, group headers,
// sidebar rows); this file only adds percent-layout scaffolding on top.
import "@/components/schedule/gantt.css"
import "./schedule-gantt.css"

import { unwrapAction } from "@/lib/action-result"

export const dynamic = "force-dynamic"

/* ── Desk doctrine ────────────────────────────────────────────────────────
   The org /schedule desk is a portfolio Gantt. Rows are PROJECTS on one shared
   time axis; each bar spans a job's whole lifecycle (project dates unioned with
   its items). Collapsed to a health-colored rollup by default; expand a row to
   its items as bars. The axis preloads every active job but renders at a fixed
   day-level pixel density (Day/Week/Month zoom) with horizontal scroll, opening
   on TODAY — so it reads like the project-scoped Gantt, not a squashed overview.
   Marks are shared with that Gantt (components/schedule/gantt.css). Clicking an
   item opens it in its project's schedule. The only mutation is one-click "mark
   complete" on an at-risk/overdue item, via the project workbench action.  */

const LANE_WEEKS = 4
const LABEL_W = 300
const LABEL_COL = "grid-cols-[300px_var(--tl-w)]"
const HEADER_H = 46
const BAND_H = 30
const PROJECT_H = 54
const ITEM_H = 46
const PROJECT_BAR_H = 22
const ITEM_BAR_H = 28
const MILESTONE = 16

// Pixels per day per zoom. Day is roomy like the project Gantt; Month is a
// portfolio overview. Default Week keeps individual weeks legible.
const ZOOM_PX = { day: 26, week: 10, month: 3 } as const
type Zoom = keyof typeof ZOOM_PX
const ZOOM_LABEL: Record<Zoom, string> = { month: "Months", week: "Weeks", day: "Days" }

// Health reuses the aging ramp (tokens only): on-track (blue) → at-risk (amber)
// → behind (red), plus success-green for wrapped work.
const HEALTH = {
  behind: { color: "var(--age-2)", label: "Behind" },
  at_risk: { color: "var(--age-1)", label: "At risk" },
  on_track: { color: "var(--age-0)", label: "On track" },
  done: { color: "var(--success)", label: "Wrapping up" },
} as const

type Health = keyof typeof HEALTH

const HARD_DATE_TYPES = new Set(["milestone", "inspection", "handoff", "delivery"])

interface DatedItem extends ScheduleItem {
  start: Date | null
  end: Date | null
}

interface HardDate {
  id: string
  name: string
  date: Date
  late: boolean
}

interface ProjectRow {
  project: Project
  items: DatedItem[]
  spanStart: Date
  spanEnd: Date
  progress: number
  health: Health
  daysBehind: number
  phase: string | null
  hardDates: HardDate[]
}

function isOpen(item: ScheduleItem) {
  return item.status !== "completed" && item.status !== "cancelled"
}

function itemHref(projectId: string, itemId: string) {
  return `/projects/${projectId}/schedule?item=${itemId}`
}

function minDate(a: Date | null, b: Date | null) {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
}
function maxDate(a: Date | null, b: Date | null) {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

/** The job's current lifecycle phase: what's in flight today, else what's next. */
function currentPhase(items: DatedItem[], today: Date): string | null {
  const overlapping = items.filter(
    (item) =>
      isOpen(item) &&
      item.phase &&
      item.start &&
      item.end &&
      item.start <= today &&
      item.end >= today,
  )
  const pool =
    overlapping.length > 0
      ? overlapping
      : items.filter((item) => isOpen(item) && item.phase && item.start && item.start >= today)
  if (pool.length === 0) return null
  const weight = new Map<string, number>()
  for (const item of pool) {
    const phase = item.phase!.trim()
    weight.set(phase, (weight.get(phase) ?? 0) + (item.status === "in_progress" ? 2 : 1))
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function buildProjectRow(project: Project, items: DatedItem[], today: Date): ProjectRow | null {
  let itemsStart: Date | null = null
  let itemsEnd: Date | null = null
  let weightTotal = 0
  let weightDone = 0
  let daysBehind = 0
  let hasBlocked = false
  let hasAtRisk = false

  for (const item of items) {
    itemsStart = minDate(itemsStart, item.start)
    itemsEnd = maxDate(itemsEnd, item.end)

    const duration =
      item.start && item.end ? Math.max(1, differenceInCalendarDays(item.end, item.start) + 1) : 1
    weightTotal += duration
    weightDone +=
      duration *
      (item.status === "completed" ? 1 : Math.min(Math.max((item.progress ?? 0) / 100, 0), 1))

    if (isOpen(item)) {
      if (item.status === "blocked") hasBlocked = true
      if (item.status === "at_risk") hasAtRisk = true
      if (item.end && item.end < today) {
        daysBehind = Math.max(daysBehind, differenceInCalendarDays(today, item.end))
      }
    }
  }

  // The bar spans the project's whole lifecycle: its contract dates unioned with
  // wherever its scheduled work actually sits.
  const spanStart = minDate(itemsStart, parseDate(project.start_date))
  const spanEnd = maxDate(itemsEnd, parseDate(project.end_date))
  if (!spanStart || !spanEnd) return null

  const allDone = items.length > 0 && items.every((item) => item.status === "completed")
  const health: Health =
    daysBehind > 0 || hasBlocked ? "behind" : hasAtRisk ? "at_risk" : allDone ? "done" : "on_track"

  const hardDates = items
    .filter(
      (item) => HARD_DATE_TYPES.has(item.item_type) && isOpen(item) && (item.end ?? item.start),
    )
    .map((item) => {
      const date = (item.end ?? item.start) as Date
      return { id: item.id, name: item.name, date, late: date < today }
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime())

  const sortedItems = [...items].sort((a, b) => {
    const as = a.start?.getTime() ?? Number.MAX_SAFE_INTEGER
    const bs = b.start?.getTime() ?? Number.MAX_SAFE_INTEGER
    return as - bs || (a.end?.getTime() ?? 0) - (b.end?.getTime() ?? 0)
  })

  return {
    project,
    items: sortedItems,
    spanStart,
    spanEnd,
    progress: weightTotal > 0 ? Math.round((weightDone / weightTotal) * 100) : 0,
    health,
    daysBehind,
    phase: currentPhase(items, today),
    hardDates,
  }
}

/* ── Cross-project crew collisions ──────────────────────────────────────── */

interface Collision {
  trade: string
  projectNames: string[]
}

function overlaps(a: DatedItem, b: DatedItem) {
  return (
    a.start !== null &&
    a.end !== null &&
    b.start !== null &&
    b.end !== null &&
    a.start <= b.end &&
    b.start <= a.end
  )
}

function analyzeCollisions(
  items: DatedItem[],
  windowStart: Date,
  windowEnd: Date,
  projectById: Map<string, Project>,
) {
  const inWindow = items.filter(
    (item) =>
      isOpen(item) && item.start && item.end && item.start <= windowEnd && item.end >= windowStart,
  )

  const byTrade = new Map<string, DatedItem[]>()
  for (const item of inWindow) {
    if (!item.trade) continue
    const key = item.trade.trim().toLowerCase()
    const list = byTrade.get(key)
    if (list) list.push(item)
    else byTrade.set(key, [item])
  }

  const clashItemIds = new Set<string>()
  const projectsWithClash = new Set<string>()
  const byTradeCollision = new Map<string, { display: string; projects: Set<string> }>()

  for (const tradeItems of byTrade.values()) {
    for (let i = 0; i < tradeItems.length; i++) {
      for (let j = i + 1; j < tradeItems.length; j++) {
        const a = tradeItems[i]
        const b = tradeItems[j]
        if (a.project_id === b.project_id || !overlaps(a, b)) continue
        clashItemIds.add(a.id)
        clashItemIds.add(b.id)
        projectsWithClash.add(a.project_id)
        projectsWithClash.add(b.project_id)
        const key = a.trade!.trim().toLowerCase()
        const existing = byTradeCollision.get(key)
        if (existing) {
          existing.projects.add(a.project_id)
          existing.projects.add(b.project_id)
        } else {
          byTradeCollision.set(key, {
            display: a.trade!.trim(),
            projects: new Set([a.project_id, b.project_id]),
          })
        }
      }
    }
  }

  const collisions: Collision[] = [...byTradeCollision.values()].map((entry) => ({
    trade: entry.display,
    projectNames: [...entry.projects]
      .map((id) => projectById.get(id)?.name)
      .filter((name): name is string => Boolean(name)),
  }))

  const untradedCount = inWindow.filter((item) => !item.trade).length
  return { collisions, clashItemIds, projectsWithClash, untradedCount }
}

/* ── Gantt geometry (fixed pixels-per-day, horizontal scroll) ───────────── */

interface Axis {
  start: Date
  pxPerDay: number
  totalWidth: number
  zoom: Zoom
  months: Date[]
  weeks: Date[]
  days: Date[]
}

function dayPx(date: Date, axis: Axis) {
  return differenceInCalendarDays(date, axis.start) * axis.pxPerDay
}

function barPx(start: Date, end: Date, axis: Axis) {
  const left = dayPx(start, axis)
  const days = Math.max(1, differenceInCalendarDays(end, start) + 1)
  const width = Math.max(6, days * axis.pxPerDay - 2)
  return { left, width }
}

function isMilestone(item: DatedItem) {
  if (HARD_DATE_TYPES.has(item.item_type)) return true
  return Boolean(item.start && item.end && differenceInCalendarDays(item.end, item.start) === 0)
}

function itemColor(item: DatedItem, today: Date): string {
  if (item.status === "completed") return "var(--success)"
  if ((item.end && item.end < today) || item.status === "blocked") return "var(--age-2)"
  if (item.status === "at_risk") return "var(--age-1)"
  if (item.status === "in_progress") return "var(--age-0)"
  return "var(--muted-foreground)"
}

/* ── Chart chrome ───────────────────────────────────────────────────────── */

function MonthHeader({ axis }: { axis: Axis }) {
  // A second row of period numbers — day-of-month per day (Day zoom) or per week
  // (Week zoom) — mirroring the project-scoped Gantt's day header.
  const ticks = axis.zoom === "day" ? axis.days : axis.zoom === "week" ? axis.weeks : []
  const tickWidth = axis.zoom === "day" ? axis.pxPerDay : 7 * axis.pxPerDay
  return (
    <div className={cn("sticky top-0 z-30 grid border-b bg-background", LABEL_COL)}>
      <div
        className="pg-label z-40 flex items-center gap-1.5 border-r px-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        style={{ height: HEADER_H }}
      >
        <CalendarDays className="size-3.5" />
        Project
      </div>
      <div className="flex flex-col" style={{ height: HEADER_H }}>
        {/* Months */}
        <div className="relative flex-1 border-b border-border/40">
          {axis.months.map((month) => (
            <div
              key={month.getTime()}
              className="absolute inset-y-0 flex items-center border-l border-border/40 pl-1.5"
              style={{ left: dayPx(month, axis) }}
            >
              <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-foreground">
                {format(month, month.getMonth() === 0 ? "MMM ''yy" : "MMM")}
              </span>
            </div>
          ))}
        </div>
        {/* Day / period numbers */}
        <div className="relative flex-1">
          {ticks.map((tick) => {
            const weekend = axis.zoom === "day" && (tick.getDay() === 0 || tick.getDay() === 6)
            return (
              <div
                key={tick.getTime()}
                className={cn(
                  "absolute inset-y-0 flex items-center overflow-hidden border-l border-border/25",
                  axis.zoom === "day" ? "justify-center" : "pl-1",
                )}
                style={{ left: dayPx(tick, axis), width: tickWidth }}
              >
                <span
                  className={cn(
                    "text-[10px] tabular-nums",
                    weekend ? "text-muted-foreground/50" : "text-muted-foreground",
                  )}
                >
                  {format(tick, "d")}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function GridOverlay({ axis, today }: { axis: Axis; today: Date }) {
  const todayInRange = today >= axis.start
  return (
    <div className="pointer-events-none absolute inset-y-0 left-[300px] right-0">
      {axis.zoom === "day"
        ? axis.days.map((day) => (
            <div key={`d${day.getTime()}`} className="pg-gridline-day" style={{ left: dayPx(day, axis) }} />
          ))
        : null}
      {axis.weeks.map((week) => (
        <div key={week.getTime()} className="pg-gridline-week" style={{ left: dayPx(week, axis) }} />
      ))}
      {axis.months.map((month) => (
        <div key={month.getTime()} className="pg-gridline" style={{ left: dayPx(month, axis) }} />
      ))}
      {todayInRange ? (
        <>
          <div className="gantt-today-line" style={{ left: dayPx(today, axis) + axis.pxPerDay / 2 }} />
          <div className="gantt-today-pill" style={{ left: dayPx(today, axis) + axis.pxPerDay / 2 }}>
            Today
          </div>
        </>
      ) : null}
    </div>
  )
}

function GroupBand({ health, count }: { health: Health; count: number }) {
  return (
    <div className={cn("grid", LABEL_COL)}>
      <div
        className="sticky left-0 z-20 flex items-center gap-2 border-b border-r bg-muted px-3"
        style={{ height: BAND_H }}
      >
        <span className="size-2" style={{ backgroundColor: HEALTH[health].color }} />
        <span
          className="flex-1 text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: HEALTH[health].color }}
        >
          {HEALTH[health].label}
        </span>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{count}</span>
      </div>
      <div className="border-b bg-muted/50" style={{ height: BAND_H }} />
    </div>
  )
}

/* ── Rows ───────────────────────────────────────────────────────────────── */

function ItemMark({
  item,
  axis,
  today,
  clashing,
}: {
  item: DatedItem
  axis: Axis
  today: Date
  clashing: boolean
}) {
  if (!item.start && !item.end) return null
  const color = itemColor(item, today)
  const date = (item.end ?? item.start) as Date

  if (isMilestone(item)) {
    return (
      <div
        className="gantt-milestone pointer-events-none"
        style={
          {
            left: dayPx(date, axis) + axis.pxPerDay / 2 - MILESTONE / 2,
            top: `calc(50% - ${MILESTONE / 2}px)`,
            width: MILESTONE,
            height: MILESTONE,
            "--bar-color": color,
          } as React.CSSProperties
        }
      >
        <Flag className="h-2.5 w-2.5" fill="currentColor" />
      </div>
    )
  }

  const { left, width } = barPx(item.start ?? date, item.end ?? date, axis)
  const progress = item.status === "completed" ? 100 : Math.min(100, Math.max(0, item.progress ?? 0))
  return (
    <div
      className={cn(
        "gantt-task-bar pointer-events-none absolute",
        item.status === "completed" && "is-completed",
      )}
      style={
        {
          left,
          width,
          top: "50%",
          height: ITEM_BAR_H,
          transform: "translateY(-50%)",
          boxShadow: clashing
            ? "inset 0 0 0 1px color-mix(in oklab, var(--foreground) 14%, transparent), 0 0 0 1.5px var(--age-2)"
            : undefined,
          "--bar-color": color,
        } as React.CSSProperties
      }
    >
      {progress < 100 ? (
        <div className="gantt-progress-section">
          <div className="gantt-bar-remainder" style={{ left: `${progress}%`, width: `${100 - progress}%` }} />
        </div>
      ) : null}
    </div>
  )
}

function ProjectGanttRow({
  row,
  axis,
  today,
  clashItemIds,
  hasClash,
}: {
  row: ProjectRow
  axis: Axis
  today: Date
  clashItemIds: Set<string>
  hasClash: boolean
}) {
  const health = HEALTH[row.health]
  const span = barPx(row.spanStart, row.spanEnd, axis)

  return (
    <details className="group">
      <summary
        className={cn(
          "pg-row grid cursor-pointer list-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
          "[&::-webkit-details-marker]:hidden",
          LABEL_COL,
        )}
      >
        {/* Label */}
        <div className="pg-label gantt-sidebar-row gap-1.5" style={{ height: PROJECT_H }}>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground">
              {row.project.name}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {row.phase ? (
                <span className="truncate capitalize">{row.phase.replace(/_/g, " ")}</span>
              ) : null}
              {row.project.status === "on_hold" ? (
                <span className="shrink-0 border px-1 text-[9px] uppercase tracking-wide">hold</span>
              ) : null}
              {hasClash ? <span className="shrink-0 font-medium text-[var(--age-2)]">· clash</span> : null}
            </div>
          </div>
          <div className="shrink-0 text-right leading-tight">
            <div className="font-mono text-xs tabular-nums text-foreground">{row.progress}%</div>
            {row.daysBehind > 0 ? (
              <div className="text-[10px] font-medium text-[var(--age-2)]">{row.daysBehind}d</div>
            ) : null}
          </div>
        </div>

        {/* Rollup track */}
        <div className="pg-track" style={{ height: PROJECT_H }}>
          <div
            className="gantt-task-bar absolute"
            style={
              {
                left: span.left,
                width: span.width,
                top: "50%",
                height: PROJECT_BAR_H,
                transform: "translateY(-50%)",
                "--bar-color": health.color,
              } as React.CSSProperties
            }
          >
            {row.progress < 100 ? (
              <div className="gantt-progress-section">
                <div
                  className="gantt-bar-remainder"
                  style={{ left: `${row.progress}%`, width: `${100 - row.progress}%` }}
                />
              </div>
            ) : null}
          </div>
          {row.hardDates.map((hd) => (
            <div
              key={hd.id}
              className="gantt-milestone"
              style={
                {
                  left: dayPx(hd.date, axis) + axis.pxPerDay / 2 - MILESTONE / 2,
                  top: `calc(50% - ${MILESTONE / 2}px)`,
                  width: MILESTONE,
                  height: MILESTONE,
                  "--bar-color": hd.late ? "var(--age-2)" : "var(--age-0)",
                } as React.CSSProperties
              }
              title={`${hd.name} — ${format(hd.date, "MMM d")}`}
            >
              <Flag className="h-2.5 w-2.5" fill="currentColor" />
            </div>
          ))}
        </div>
      </summary>

      {/* Expanded: this project's items as bars */}
      {row.items.length === 0 ? (
        <div className={cn("grid", LABEL_COL)}>
          <div
            className="pg-label gantt-sidebar-row text-[11px] text-muted-foreground"
            style={{ height: ITEM_H }}
          >
            <span className="pl-6">No dated schedule items yet.</span>
          </div>
          <div className="pg-track" style={{ height: ITEM_H }} />
        </div>
      ) : (
        row.items.map((item) => {
          const needsAction =
            isOpen(item) &&
            (item.status === "blocked" ||
              item.status === "at_risk" ||
              Boolean(item.end && item.end < today))
          const href = itemHref(row.project.id, item.id)
          return (
            <div key={item.id} className={cn("pg-row grid", LABEL_COL)}>
              <div className="pg-label gantt-sidebar-row gap-2" style={{ height: ITEM_H }}>
                <Link
                  href={href}
                  className="min-w-0 flex-1 truncate pl-6 text-[13px] text-foreground underline-offset-4 hover:underline"
                >
                  <span className={cn(item.status === "completed" && "text-muted-foreground/70 line-through")}>
                    {item.name}
                  </span>
                  {item.trade ? (
                    <span className="ml-1.5 text-[11px] capitalize text-muted-foreground">
                      {item.trade.replace(/_/g, " ")}
                    </span>
                  ) : null}
                </Link>
                {needsAction ? (
                  <MarkScheduleItemCompleteButton itemId={item.id} itemName={item.name} />
                ) : null}
              </div>
              <Link
                href={href}
                className="pg-track block"
                style={{ height: ITEM_H }}
                title={`${item.name} — ${item.start ? format(item.start, "MMM d") : "?"}${
                  item.end && item.start && item.end.getTime() !== item.start.getTime()
                    ? `–${format(item.end, "MMM d")}`
                    : ""
                }`}
              >
                <ItemMark item={item} axis={axis} today={today} clashing={clashItemIds.has(item.id)} />
              </Link>
            </div>
          )
        })
      )}
    </details>
  )
}

/* ── Page ───────────────────────────────────────────────────────────────── */

const GROUP_ORDER: Health[] = ["behind", "at_risk", "on_track", "done"]

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <span className="h-2 w-3.5" style={{ background: color }} />
      {label}
    </span>
  )
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ zoom?: string }>
}) {
  const { zoom: zoomParam } = await searchParams
  const zoom: Zoom = zoomParam === "day" || zoomParam === "month" ? zoomParam : "week"

  const [projects, allItems] = await Promise.all([listProjectsAction(), listScheduleItemsAction()])
  const today = startOfDay(new Date())

  const ACTIVE_STATUSES = new Set(["planning", "bidding", "active", "on_hold"])
  const activeProjects = projects.filter((project) => ACTIVE_STATUSES.has(project.status))
  const projectById = new Map(activeProjects.map((project) => [project.id, project]))

  const items: DatedItem[] = allItems
    .filter((item) => item.status !== "cancelled" && projectById.has(item.project_id))
    .map((item) => {
      const start = parseDate(item.start_date) ?? parseDate(item.end_date)
      const end = parseDate(item.end_date) ?? parseDate(item.start_date)
      return { ...item, start, end }
    })

  const itemsByProject = new Map<string, DatedItem[]>()
  for (const item of items) {
    const list = itemsByProject.get(item.project_id)
    if (list) list.push(item)
    else itemsByProject.set(item.project_id, [item])
  }

  const rows = activeProjects
    .map((project) => buildProjectRow(project, itemsByProject.get(project.id) ?? [], today))
    .filter((row): row is ProjectRow => row !== null)

  const rowsByHealth: Record<Health, ProjectRow[]> = { behind: [], at_risk: [], on_track: [], done: [] }
  for (const row of rows) rowsByHealth[row.health].push(row)
  for (const health of GROUP_ORDER) {
    rowsByHealth[health].sort((a, b) => a.spanStart.getTime() - b.spanStart.getTime())
  }

  const counts: Record<Health, number> = {
    behind: rowsByHealth.behind.length,
    at_risk: rowsByHealth.at_risk.length,
    on_track: rowsByHealth.on_track.length,
    done: rowsByHealth.done.length,
  }

  const week0 = startOfWeek(today, { weekStartsOn: 1 })
  const { collisions, clashItemIds, projectsWithClash, untradedCount } = analyzeCollisions(
    items,
    week0,
    new Date(week0.getTime() + (LANE_WEEKS * 7 - 1) * 86400000),
    projectById,
  )
  const overdueCount = items.filter((item) => isOpen(item) && item.end && item.end < today).length

  if (activeProjects.length === 0) {
    return (
      <PageLayout title="Schedule">
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <CalendarDays className="size-10 text-muted-foreground/50" />
          <h2 className="text-lg font-semibold">No active projects</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            The schedule desk lays every active job on one timeline and flags where trades collide
            across projects.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link href="/projects">Go to projects</Link>
          </Button>
        </div>
      </PageLayout>
    )
  }

  // Axis fits every active job's lifecycle, snapped to whole months, rendered at
  // a fixed day-level density with horizontal scroll.
  const axis: Axis | null =
    rows.length > 0
      ? (() => {
          const min = rows.reduce(
            (acc, row) => (row.spanStart < acc ? row.spanStart : acc),
            rows[0].spanStart,
          )
          const max = rows.reduce(
            (acc, row) => (row.spanEnd > acc ? row.spanEnd : acc),
            rows[0].spanEnd,
          )
          const start = startOfMonth(min)
          const end = endOfMonth(max)
          const pxPerDay = ZOOM_PX[zoom]
          const totalDays = differenceInCalendarDays(end, start) + 1
          return {
            start,
            pxPerDay,
            totalWidth: totalDays * pxPerDay,
            zoom,
            months: eachMonthOfInterval({ start, end }),
            weeks: eachWeekOfInterval({ start, end }, { weekStartsOn: 1 }),
            days: zoom === "day" ? eachDayOfInterval({ start, end }) : [],
          }
        })()
      : null

  const initialScrollLeft = axis ? Math.max(0, dayPx(today, axis) - 80) : 0

  return (
    <PageLayout title="Schedule" fullBleed>
      <div className="desk-root flex h-[calc(100vh-56px)] flex-col overflow-hidden">
        {/* ── Context + zoom + legend ── */}
        <div className="desk-rise flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b px-4 py-2.5 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">{rows.length}</span> active{" "}
              {rows.length === 1 ? "job" : "jobs"}
            </span>
            {counts.behind > 0 ? (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="font-medium text-[var(--age-2)]">
                  {counts.behind} behind
                  {overdueCount > 0 ? `, ${overdueCount} overdue` : ""}
                </span>
              </>
            ) : (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-[var(--success)]">nothing behind</span>
              </>
            )}
            {collisions.length > 0 ? (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span
                  className="font-medium text-[var(--age-2)]"
                  title={collisions.map((c) => `${c.trade}: ${c.projectNames.join(" + ")}`).join("\n")}
                >
                  {collisions.length} crew {collisions.length === 1 ? "collision" : "collisions"}
                </span>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            {/* Zoom — a server round-trip, no client state */}
            <div className="flex items-center border p-0.5 text-xs">
              {(["month", "week", "day"] as Zoom[]).map((z) => (
                <Link
                  key={z}
                  href={`/schedule?zoom=${z}`}
                  scroll={false}
                  className={cn(
                    "px-2 py-0.5",
                    z === zoom
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {ZOOM_LABEL[z]}
                </Link>
              ))}
            </div>
            <div className="hidden items-center gap-x-4 text-[11px] lg:flex">
              <LegendSwatch color="var(--age-2)" label="Behind" />
              <LegendSwatch color="var(--age-1)" label="At risk" />
              <LegendSwatch color="var(--age-0)" label="On track" />
              <LegendSwatch color="var(--success)" label="Wrapping up" />
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                <span className="h-3 w-px bg-[var(--primary)]" /> today
              </span>
            </div>
          </div>
        </div>

        {/* ── The portfolio Gantt — one internal scroll region, opens on today ── */}
        {axis === null ? (
          <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
            No project has dated schedule items yet — build one from a project&apos;s Schedule tab.
          </div>
        ) : (
          <GanttScrollArea
            initialScrollLeft={initialScrollLeft}
            className="min-h-0 flex-1 overflow-auto"
          >
            <div
              style={{ width: LABEL_W + axis.totalWidth, ["--tl-w" as string]: `${axis.totalWidth}px` } as React.CSSProperties}
            >
              <MonthHeader axis={axis} />
              <div className="relative">
                <GridOverlay axis={axis} today={today} />
                {GROUP_ORDER.map((health) =>
                  rowsByHealth[health].length > 0 ? (
                    <div key={health}>
                      <GroupBand health={health} count={rowsByHealth[health].length} />
                      {rowsByHealth[health].map((row) => (
                        <ProjectGanttRow
                          key={row.project.id}
                          row={row}
                          axis={axis}
                          today={today}
                          clashItemIds={clashItemIds}
                          hasClash={projectsWithClash.has(row.project.id)}
                        />
                      ))}
                    </div>
                  ) : null,
                )}
              </div>
            </div>
          </GanttScrollArea>
        )}

        {untradedCount > 0 ? (
          <div className="shrink-0 border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">
            {untradedCount} scheduled {untradedCount === 1 ? "item" : "items"} in the next{" "}
            {LANE_WEEKS} weeks {untradedCount === 1 ? "has" : "have"} no trade set — set one to catch
            crew double-bookings.
          </div>
        ) : null}
      </div>
    </PageLayout>
  )
}
