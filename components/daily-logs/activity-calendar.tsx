"use client"

import { useMemo } from "react"
import { format, isSameDay, parseISO } from "date-fns"

import { Calendar } from "@/components/ui/calendar"
import { Button } from "@/components/ui/button"
import type { DailyLog } from "@/lib/types"
import type { EnhancedFileMetadata } from "@/app/(app)/projects/[id]/actions"

interface ActivityCalendarProps {
  dailyLogs: DailyLog[]
  photos: EnhancedFileMetadata[]
  selectedDate: Date | undefined
  onSelectDate: (date: Date | undefined) => void
}

export function ActivityCalendar({
  dailyLogs,
  photos,
  selectedDate,
  onSelectDate,
}: ActivityCalendarProps) {
  const { activeDays, alertDays, totalLoggedDays } = useMemo(() => {
    const alerts = new Set<string>()
    const actives = new Set<string>()

    for (const log of dailyLogs) {
      actives.add(log.date)
      const hasFailed = (log.entries ?? []).some(
        (e) => e.entry_type === "inspection" && e.inspection_result === "fail",
      )
      if (hasFailed) alerts.add(log.date)
    }

    for (const photo of photos) {
      const key = format(parseISO(photo.created_at), "yyyy-MM-dd")
      actives.add(key)
    }

    const total = new Set([...actives, ...alerts]).size
    for (const k of alerts) actives.delete(k)

    return {
      activeDays: Array.from(actives).map((k) => parseISO(k)),
      alertDays: Array.from(alerts).map((k) => parseISO(k)),
      totalLoggedDays: total,
    }
  }, [dailyLogs, photos])

  const today = new Date()

  function handleSelect(date: Date | undefined) {
    if (!date) {
      onSelectDate(undefined)
      return
    }
    if (selectedDate && isSameDay(date, selectedDate)) {
      onSelectDate(undefined)
      return
    }
    onSelectDate(date)
  }

  return (
    <div className="flex flex-col">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-none">Activity</h3>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            {totalLoggedDays} {totalLoggedDays === 1 ? "day" : "days"} with entries
          </p>
        </div>
        {selectedDate && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs -mr-2"
            onClick={() => onSelectDate(undefined)}
          >
            Clear
          </Button>
        )}
      </div>

      <Calendar
        mode="single"
        selected={selectedDate}
        onSelect={handleSelect}
        defaultMonth={selectedDate ?? today}
        showOutsideDays={false}
        modifiers={{
          activeDay: activeDays,
          alertDay: alertDays,
        }}
        modifiersClassNames={{
          activeDay:
            "relative after:absolute after:content-[''] after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:h-1 after:w-1 after:rounded-full after:bg-primary data-[selected-single=true]:after:bg-primary-foreground",
          alertDay:
            "relative after:absolute after:content-[''] after:bottom-1 after:left-1/2 after:-translate-x-1/2 after:h-1 after:w-1 after:rounded-full after:bg-red-500 data-[selected-single=true]:after:bg-white",
        }}
        className="p-0 [--cell-size:--spacing(9)]"
      />

      <div className="flex items-center gap-4 mt-4 pt-3 border-t">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          <span className="text-[11px] text-muted-foreground">Activity</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-red-500" />
          <span className="text-[11px] text-muted-foreground">Issue</span>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground/70 mt-4 leading-relaxed">
        Click a day to jump to it. Click again to clear.
      </p>
    </div>
  )
}
