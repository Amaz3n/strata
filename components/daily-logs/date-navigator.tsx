"use client"

import { useEffect, useState } from "react"
import { addMonths, eachDayOfInterval, endOfMonth, format, isWeekend, parseISO, startOfMonth } from "date-fns"
import { ChevronLeft, ChevronRight, Search } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import { loadDailyLogHistoryAction } from "@/lib/daily-logs/read-client"
import { cn } from "@/lib/utils"

// Extracting the success member retains the server action's typed DTO.
type HistoryRows = Extract<Awaited<ReturnType<typeof loadDailyLogHistoryAction>>, { success: true }>["data"]

export function DateNavigator({
  projectId,
  selectedDate,
  today,
  onSelect,
  review,
  revision,
  projectStartDate,
}: {
  projectId: string
  selectedDate: string
  today: string
  onSelect: (date: string) => void
  review: boolean
  revision: string
  projectStartDate?: string
}) {
  const [month, setMonth] = useState(selectedDate.slice(0, 7) + "-01")
  const [rows, setRows] = useState<HistoryRows>([])
  const [search, setSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    setMonth(selectedDate.slice(0, 7) + "-01")
  }, [selectedDate])
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    loadDailyLogHistoryAction(projectId, month)
      .then(unwrapAction)
      .then((data) => {
        if (active) setRows(data)
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "History is unavailable")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, month, retry, revision])
  const query = search.trim().toLowerCase()
  const visible = rows.filter((row) => `${row.date} ${row.searchText}`.toLowerCase().includes(query))
  const missingDates =
    review && missing && !query
      ? eachDayOfInterval({ start: startOfMonth(parseISO(month)), end: endOfMonth(parseISO(month)) }).filter(
          (date) =>
            (!projectStartDate || format(date, "yyyy-MM-dd") >= projectStartDate.slice(0, 10)) &&
            !isWeekend(date) &&
            format(date, "yyyy-MM-dd") < today &&
            !rows.some((row) => row.date === format(date, "yyyy-MM-dd")),
        )
      : []
  return (
    <nav aria-label="Daily log history" className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="space-y-4 border-b px-4 py-5">
        <p className="text-sm font-semibold">History</p>
        <Button
          variant={selectedDate === today ? "secondary" : "ghost"}
          className="w-full justify-between"
          onClick={() => onSelect(today)}
        >
          <span>Today</span>
          <span className="text-xs font-normal text-muted-foreground">{format(parseISO(today), "MMM d")}</span>
        </Button>
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Previous month"
            onClick={() => setMonth(format(addMonths(parseISO(month), -1), "yyyy-MM-dd"))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs font-medium">{format(parseISO(month), "MMMM yyyy")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Next month"
            disabled={month.slice(0, 7) >= today.slice(0, 7)}
            onClick={() => setMonth(format(addMonths(parseISO(month), 1), "yyyy-MM-dd"))}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        <label className="flex items-center gap-2 border-b pb-2">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search this month’s notes"
            aria-label="Search this month’s notes"
            className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
        </label>
        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          Jump to date
          <Input
            type="date"
            aria-label="Jump to date"
            value={selectedDate}
            max={today}
            onChange={(event) => {
              if (event.target.value) onSelect(event.target.value)
            }}
            className="h-8 w-36 text-xs"
          />
        </label>
        {review && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={missing} onChange={(event) => setMissing(event.target.checked)} />
            Show unlogged weekdays
          </label>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="space-y-3 p-2" aria-label="Loading history">
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="p-3 text-xs text-destructive" role="alert">
            {error}
            <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {visible.map((row) => (
              <button
                key={row.date}
                onClick={() => onSelect(row.date)}
                aria-current={row.date === selectedDate ? "date" : undefined}
                className={cn(
                  "mb-1 w-full border-l-2 border-transparent px-3 py-3 text-left transition-colors hover:bg-muted",
                  row.date === selectedDate && "border-primary bg-muted",
                )}
              >
                <span className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium">{format(parseISO(row.date), "EEE, MMM d")}</span>
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      row.status === "submitted" ? "bg-success" : "bg-muted-foreground/40",
                    )}
                    title={row.status === "submitted" ? "Submitted" : "Draft"}
                  />
                </span>
                <span className="mt-1 block truncate text-xs leading-5 text-muted-foreground">
                  {row.summary || `${row.count} log${row.count === 1 ? "" : "s"}`}
                </span>
              </button>
            ))}
            {visible.length === 0 && (
              <p className="px-3 py-8 text-center text-xs leading-5 text-muted-foreground">
                {query ? "No matching notes this month." : "No records this month. Use the arrows or jump to a date."}
              </p>
            )}
            {missingDates.map((date) => (
              <button
                key={date.toISOString()}
                className="block w-full px-3 py-2 text-left text-xs text-muted-foreground hover:bg-muted"
                onClick={() => onSelect(format(date, "yyyy-MM-dd"))}
              >
                {format(date, "EEE, MMM d")} <span className="float-right">Unlogged</span>
              </button>
            ))}
          </>
        )}
      </div>
    </nav>
  )
}
