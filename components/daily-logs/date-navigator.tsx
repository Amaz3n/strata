"use client"

import { type ComponentProps, useEffect, useMemo, useRef, useState } from "react"
import { addMonths, format, isSameDay, isSameMonth } from "date-fns"

import { cn } from "@/lib/utils"
import { Calendar, CalendarDayButton } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  ChevronLeft,
  ChevronRight,
  Search,
  Camera,
  AlertTriangle,
  Clock,
  Users,
  CalendarDays,
  Check,
} from "@/components/icons"
import type { DayBucket, DayCompleteness } from "./day-aggregate"
import { buildDaySpine, dayCompleteness, daySummaryLine, weatherEmoji } from "./day-aggregate"
import { CompletenessRing } from "./completeness-ring"
import { DAILY_LOGS_PANE_HEADER_CLASS, DAILY_LOGS_PANE_SUBHEADER_CLASS } from "./layout"

/**
 * One day cell. Renders selected/today/log-dot all on the same inner button so
 * every state is identical in size — no cell-vs-button mismatch.
 */
function NavDayButton({ className, children, modifiers, ...props }: ComponentProps<typeof CalendarDayButton>) {
  const dotColor = modifiers.alertDay
    ? "bg-destructive"
    : modifiers.rainDay
      ? "bg-sky-500"
      : modifiers.logged
        ? "bg-primary"
        : null

  return (
    <CalendarDayButton
      modifiers={modifiers}
      className={cn(
        "relative",
        // Today (when not the selected day) reads as an outline, not a fill.
        modifiers.today && !modifiers.selected && "ring-1 ring-inset ring-primary/40",
        className,
      )}
      {...props}
    >
      {children}
      {dotColor && (
        <span
          className={cn(
            "pointer-events-none absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full",
            // On the selected (filled) day, switch to a contrasting dot.
            modifiers.selected ? "bg-primary-foreground" : dotColor,
          )}
        />
      )}
    </CalendarDayButton>
  )
}

// ---------------------------------------------------------------------------
// Search snippets — the answer to "when did ABC Plumbing stop showing up" is a
// list of days with the matching line, not a list of counts.
// ---------------------------------------------------------------------------

function searchableFields(b: DayBucket): string[] {
  return [
    b.weather,
    ...b.logs.map((l) => l.notes),
    ...b.workEntries.map((e) => [e.description, e.trade, e.location].filter(Boolean).join(" ")),
    ...(b.report?.manpower ?? []).map((m) => [m.company, m.trade, m.notes].filter(Boolean).join(" ")),
    ...b.logs.flatMap((l) => (l.comments ?? []).map((c) => c.body)),
    ...[...b.deliveries, ...b.constraints, ...b.safety].map((e) => e.description),
  ].filter((v): v is string => Boolean(v))
}

function matchSnippet(b: DayBucket, term: string): { before: string; match: string; after: string } | null {
  for (const field of searchableFields(b)) {
    const idx = field.toLowerCase().indexOf(term)
    if (idx === -1) continue
    const start = Math.max(0, idx - 32)
    const end = Math.min(field.length, idx + term.length + 48)
    return {
      before: (start > 0 ? "…" : "") + field.slice(start, idx),
      match: field.slice(idx, idx + term.length),
      after: field.slice(idx + term.length, end) + (end < field.length ? "…" : ""),
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Spine rows
// ---------------------------------------------------------------------------

function DateBlock({ date, muted, selected }: { date: Date; muted?: boolean; selected?: boolean }) {
  return (
    <div className="flex w-8 flex-shrink-0 flex-col items-center pt-0.5">
      <span
        className={cn(
          "text-[9px] font-semibold uppercase leading-none",
          muted ? "text-muted-foreground/50" : "text-muted-foreground",
        )}
      >
        {format(date, "EEE")}
      </span>
      <span
        className={cn(
          "mt-0.5 text-xl font-semibold leading-none tabular-nums",
          selected ? "text-primary" : muted ? "text-muted-foreground/50" : "text-foreground",
        )}
      >
        {format(date, "d")}
      </span>
    </div>
  )
}

function LoggedDayRow({
  bucket,
  completeness,
  isSelected,
  isToday,
  snippet,
  onSelect,
}: {
  bucket: DayBucket
  completeness: DayCompleteness
  isSelected: boolean
  isToday: boolean
  snippet: { before: string; match: string; after: string } | null
  onSelect: () => void
}) {
  const submitted = bucket.report?.status === "submitted"
  const summary = daySummaryLine(bucket)

  return (
    <button
      data-selected={isSelected || undefined}
      onClick={onSelect}
      className={cn(
        "group relative flex w-full gap-3 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors",
        isSelected ? "bg-primary/10" : "hover:bg-muted",
      )}
    >
      {isSelected && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" aria-hidden />}

      <DateBlock date={bucket.date} selected={isSelected} />

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium leading-tight">
            {summary ??
              (bucket.manpowerWorkers > 0 || (bucket.report?.manpower?.length ?? 0) > 0
                ? "Manpower only"
                : bucket.photos.length > 0
                  ? "Photos only"
                  : "Conditions only")}
          </span>
          <span className="mt-px flex flex-shrink-0 items-center gap-1.5">
            {bucket.weather && (
              <span className="text-xs leading-none" aria-hidden title={bucket.weather}>
                {weatherEmoji(bucket.weather)}
              </span>
            )}
            {submitted ? (
              <span
                className="grid h-4 w-4 place-items-center rounded-full bg-emerald-500/15"
                title="Submitted"
              >
                <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
              </span>
            ) : (
              <CompletenessRing
                completeness={completeness}
                size={16}
                className="opacity-90"
              />
            )}
          </span>
        </div>

        {snippet ? (
          <p className="mt-1 truncate text-[11px] leading-snug text-muted-foreground">
            {snippet.before}
            <mark className="rounded-[2px] bg-primary/15 px-0.5 font-medium text-foreground">{snippet.match}</mark>
            {snippet.after}
          </p>
        ) : (
          <div className="mt-1 flex items-center gap-2.5 text-[10px] text-muted-foreground">
            {bucket.manpowerWorkers > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums">
                <Users className="h-2.5 w-2.5" />
                {bucket.manpowerWorkers}
              </span>
            )}
            {bucket.totalHours > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums">
                <Clock className="h-2.5 w-2.5" />
                {bucket.totalHours}h
              </span>
            )}
            {bucket.photos.length > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums">
                <Camera className="h-2.5 w-2.5" />
                {bucket.photos.length}
              </span>
            )}
            {bucket.hasAlert && (
              <span className="flex items-center gap-0.5 font-medium text-destructive tabular-nums">
                <AlertTriangle className="h-2.5 w-2.5" />
                {bucket.failedInspections.length} failed
              </span>
            )}
            {isToday && <span className="font-medium text-primary">Today</span>}
          </div>
        )}
      </div>
    </button>
  )
}

function MissedDayRow({
  date,
  isSelected,
  isToday,
  onSelect,
}: {
  date: Date
  isSelected: boolean
  isToday: boolean
  onSelect: () => void
}) {
  return (
    <button
      data-selected={isSelected || undefined}
      onClick={onSelect}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-lg py-1.5 pl-3 pr-2.5 text-left transition-colors",
        isSelected ? "bg-primary/10" : "hover:bg-muted",
      )}
    >
      {isSelected && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary" aria-hidden />}
      <div className="flex w-8 flex-shrink-0 items-baseline justify-center gap-1">
        <span className="text-[9px] font-semibold uppercase leading-none text-muted-foreground/50">
          {format(date, "EEE")}
        </span>
        <span
          className={cn(
            "text-sm font-medium leading-none tabular-nums",
            isSelected ? "text-primary" : "text-muted-foreground/60",
          )}
        >
          {format(date, "d")}
        </span>
      </div>
      {isToday ? (
        <span className="text-[11px] font-medium text-primary">Today — start the report</span>
      ) : (
        <span className="text-[11px] text-muted-foreground/60 transition-colors group-hover:text-muted-foreground">
          Not logged
        </span>
      )}
    </button>
  )
}

interface DateNavigatorProps {
  buckets: Map<string, DayBucket>
  month: Date
  onMonthChange: (date: Date) => void
  selectedKey: string | undefined
  onSelect: (key: string) => void
  search: string
  onSearchChange: (value: string) => void
  today: Date
  projectStartDate?: string
}

export function DateNavigator({
  buckets,
  month,
  onMonthChange,
  selectedKey,
  onSelect,
  search,
  onSearchChange,
  today,
  projectStartDate,
}: DateNavigatorProps) {
  const term = search.trim().toLowerCase()

  // Old unlogged stretches collapse into one row; clicking unfolds that run.
  const [expandedGaps, setExpandedGaps] = useState<Set<string>>(new Set())

  const spine = useMemo(
    () => buildDaySpine(buckets, today, projectStartDate, expandedGaps),
    [buckets, today, projectStartDate, expandedGaps],
  )

  const completenessByKey = useMemo(() => {
    const map = new Map<string, DayCompleteness>()
    for (const b of buckets.values()) map.set(b.key, dayCompleteness(b))
    return map
  }, [buckets])

  // Search results: logged days whose text matches, with the matching line.
  const results = useMemo(() => {
    if (!term) return []
    return Array.from(buckets.values())
      .map((b) => ({ bucket: b, snippet: matchSnippet(b, term) }))
      .filter((r): r is { bucket: DayBucket; snippet: NonNullable<ReturnType<typeof matchSnippet>> } =>
        Boolean(r.snippet),
      )
      .sort((a, b) => b.bucket.key.localeCompare(a.bucket.key))
  }, [buckets, term])

  // Whole-project coverage, shown above the spine.
  const coverage = useMemo(() => {
    let workdays = 0
    let logged = 0
    for (const row of spine) {
      if (row.type === "month") {
        workdays += row.workdays
        logged += row.logged
      }
    }
    return { workdays, logged }
  }, [spine])

  // Calendar dots: failed inspection (red) > rain (sky) > activity (primary).
  const { loggedDays, alertDays, rainDays } = useMemo(() => {
    const logged: Date[] = []
    const alert: Date[] = []
    const rain: Date[] = []
    for (const b of buckets.values()) {
      if (b.hasAlert) alert.push(b.date)
      else if (b.isRain) rain.push(b.date)
      else logged.push(b.date)
    }
    return { loggedDays: logged, alertDays: alert, rainDays: rain }
  }, [buckets])

  const selectedDate = selectedKey ? buckets.get(selectedKey)?.date ?? new Date(selectedKey + "T12:00:00") : undefined

  const [calendarOpen, setCalendarOpen] = useState(false)

  // Keep the selected row visible when navigation comes from the keyboard or
  // the document's prev/next controls.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = listRef.current?.querySelector("[data-selected]")
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedKey])

  return (
    <aside className="flex w-[292px] flex-shrink-0 flex-col overflow-hidden border-r bg-muted/20">
      {/* Titlebar mirrors the report pane: identity + one compact action. */}
      <div
        className={cn(
          "flex flex-shrink-0 items-center justify-between gap-3 border-b px-4",
          DAILY_LOGS_PANE_HEADER_CLASS,
        )}
      >
        <div className="min-w-0">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Field reports
          </span>
          <span className="mt-1 block truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground/75">
            {term
              ? `${results.length} ${results.length === 1 ? "match" : "matches"}`
              : coverage.workdays > 0
                ? `${coverage.logged}/${coverage.workdays} workdays`
                : "No workdays yet"}
          </span>
        </div>

        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="icon-sm" aria-label="Jump to date" title="Jump to date">
              <CalendarDays className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
              <span className="text-[13px] font-semibold tracking-tight">{format(month, "MMMM yyyy")}</span>
              <div className="flex items-center gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground"
                  aria-label="Previous month"
                  onClick={() => onMonthChange(addMonths(month, -1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground"
                  aria-label="Next month"
                  onClick={() => onMonthChange(addMonths(month, 1))}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
            <Calendar
              mode="single"
              month={month}
              onMonthChange={onMonthChange}
              selected={selectedDate}
              onSelect={(date) => {
                if (!date) return
                onSelect(format(date, "yyyy-MM-dd"))
                setCalendarOpen(false)
              }}
              showOutsideDays={false}
              hideNavigation
              className="w-[248px] p-0 [--cell-size:--spacing(9)]"
              classNames={{
                root: "w-full",
                months: "relative flex w-full flex-col",
                month: "flex w-full flex-col gap-1.5",
                month_caption: "hidden",
                nav: "hidden",
                weekdays: "flex",
                weekday: "flex-1 select-none text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
                week: "mt-1 flex w-full",
                day: "group/day relative flex-1 select-none p-0 text-center",
                today: "",
              }}
              components={{ DayButton: NavDayButton }}
              modifiers={{ logged: loggedDays, alertDay: alertDays, rainDay: rainDays }}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* Utility row mirrors the report pane's weather/day-type row. */}
      <div className={cn("flex flex-shrink-0 items-center border-b px-4", DAILY_LOGS_PANE_SUBHEADER_CLASS)}>
        <div className="relative w-full">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search reports, crews, notes…"
            className="h-8 rounded-lg pl-8 text-sm"
          />
        </div>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {term ? (
          results.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">No reports match your search.</p>
          ) : (
            <div className="space-y-0.5">
              {results.map(({ bucket, snippet }) => (
                <LoggedDayRow
                  key={bucket.key}
                  bucket={bucket}
                  completeness={completenessByKey.get(bucket.key) ?? dayCompleteness(bucket)}
                  isSelected={bucket.key === selectedKey}
                  isToday={isSameDay(bucket.date, today)}
                  snippet={snippet}
                  onSelect={() => {
                    onSelect(bucket.key)
                    if (!isSameMonth(bucket.date, month)) onMonthChange(bucket.date)
                  }}
                />
              ))}
            </div>
          )
        ) : (
          <div className="space-y-0.5">
            {spine.map((row) => {
              switch (row.type) {
                case "month":
                  return (
                    <div
                      key={row.key}
                      className="sticky top-0 z-10 -mx-2 flex items-baseline justify-between border-b bg-muted/95 px-4 pb-1.5 pt-2.5 backdrop-blur-sm first:pt-1.5"
                    >
                      <span className="text-[11px] font-semibold tracking-tight">{format(row.date, "MMMM yyyy")}</span>
                      {row.workdays > 0 && (
                        <span
                          className={cn(
                            "font-mono text-[10px] tabular-nums",
                            row.logged === row.workdays ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground",
                          )}
                          title={`${row.logged} of ${row.workdays} workdays logged`}
                        >
                          {row.logged}/{row.workdays}
                        </span>
                      )}
                    </div>
                  )
                case "day":
                  return (
                    <LoggedDayRow
                      key={row.key}
                      bucket={row.bucket}
                      completeness={completenessByKey.get(row.key) ?? dayCompleteness(row.bucket)}
                      isSelected={row.key === selectedKey}
                      isToday={isSameDay(row.date, today)}
                      snippet={null}
                      onSelect={() => {
                        onSelect(row.key)
                        if (!isSameMonth(row.date, month)) onMonthChange(row.date)
                      }}
                    />
                  )
                case "missed":
                  return (
                    <MissedDayRow
                      key={row.key}
                      date={row.date}
                      isSelected={row.key === selectedKey}
                      isToday={isSameDay(row.date, today)}
                      onSelect={() => {
                        onSelect(row.key)
                        if (!isSameMonth(row.date, month)) onMonthChange(row.date)
                      }}
                    />
                  )
                case "weekend":
                  return (
                    <div
                      key={row.key}
                      className="flex items-center gap-2 py-1 pl-3 pr-2.5"
                      aria-label={`Weekend, ${format(row.from, "MMM d")}${isSameDay(row.from, row.to) ? "" : `–${format(row.to, "d")}`}`}
                    >
                      <span className="w-8 flex-shrink-0 text-center text-[9px] font-semibold uppercase leading-none text-muted-foreground/40">
                        {isSameDay(row.from, row.to) ? format(row.from, "EEE") : "S–S"}
                      </span>
                      <span className="h-px flex-1 bg-border/60" aria-hidden />
                      <span className="text-[9px] uppercase tracking-wide text-muted-foreground/40">Weekend</span>
                    </div>
                  )
                case "gap":
                  return (
                    <button
                      key={row.key}
                      onClick={() => setExpandedGaps((prev) => new Set(prev).add(row.key))}
                      className="group flex w-full items-center gap-2 rounded-lg py-1.5 pl-3 pr-2.5 text-left transition-colors hover:bg-muted"
                    >
                      <span className="w-8 flex-shrink-0 text-center font-mono text-[10px] tabular-nums text-muted-foreground/50">
                        {row.count}
                      </span>
                      <span className="text-[11px] text-muted-foreground/60 transition-colors group-hover:text-muted-foreground">
                        {format(row.from, "MMM d")}–{format(row.to, "d")} not logged
                      </span>
                      <ChevronRight className="ml-auto h-3 w-3 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5" />
                    </button>
                  )
              }
            })}
          </div>
        )}
      </div>
    </aside>
  )
}
