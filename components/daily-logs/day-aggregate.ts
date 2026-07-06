import { addDays, format, isWeekend, parseISO } from "date-fns"

import type { DailyLog, DailyLogEntry, DailyReport } from "@/lib/types"
import type { EnhancedFileMetadata } from "@/app/(app)/projects/[id]/actions"
import { isHeicFile } from "@/components/files/types"

export const WEATHER_OPTIONS = [
  { value: "Sunny", emoji: "☀️" },
  { value: "Partly Cloudy", emoji: "⛅" },
  { value: "Cloudy", emoji: "☁️" },
  { value: "Light Rain", emoji: "🌧️" },
  { value: "Heavy Rain", emoji: "⛈️" },
  { value: "Windy", emoji: "💨" },
  { value: "Hot", emoji: "🌡️" },
] as const

export function weatherEmoji(weather: string | undefined): string {
  if (!weather) return ""
  return WEATHER_OPTIONS.find((w) => weather.includes(w.value))?.emoji ?? "🌤️"
}

export function isRainWeather(weather: string | undefined): boolean {
  return Boolean(weather && /rain|storm/i.test(weather))
}

/** A single calendar day rolled up from every log + photo that falls on it. */
export interface DayBucket {
  key: string
  date: Date
  /** The canonical day-document, if one has been opened for this date. */
  report?: DailyReport
  logs: DailyLog[]
  photos: EnhancedFileMetadata[]
  weather?: string
  /** Total crew on site from the report's manpower rows. */
  manpowerWorkers: number
  totalHours: number
  hoursByTrade: { trade: string; hours: number }[]
  workEntries: DailyLogEntry[]
  passedInspections: DailyLogEntry[]
  failedInspections: DailyLogEntry[]
  deliveries: DailyLogEntry[]
  safety: DailyLogEntry[]
  constraints: DailyLogEntry[]
  taskUpdates: DailyLogEntry[]
  punchUpdates: DailyLogEntry[]
  commentCount: number
  mentionCount: number
  hasAlert: boolean
  isRain: boolean
  mentionsMe: boolean
  /** Rough activity weight, used to shade the calendar heat. */
  weight: number
}

export function imageFilesOf(files: EnhancedFileMetadata[]): EnhancedFileMetadata[] {
  return files.filter((f) => {
    const isImg = (f.mime_type && f.mime_type.startsWith("image/")) || isHeicFile(f.mime_type, f.file_name)
    return isImg && (f.category === "photos" || f.daily_log_id)
  })
}

/** Build one bucket per date that has any log, photo, or report. */
export function buildDayBuckets(
  dailyLogs: DailyLog[],
  imageFiles: EnhancedFileMetadata[],
  currentUserId?: string,
  reports: DailyReport[] = [],
): Map<string, DayBucket> {
  const logDatesById = new Map<string, string>()
  for (const log of dailyLogs) logDatesById.set(log.id, log.date)

  const reportsByDate = new Map<string, DailyReport>()
  for (const report of reports) reportsByDate.set(report.date, report)

  const photosByDate = new Map<string, EnhancedFileMetadata[]>()
  for (const photo of imageFiles) {
    const linkedDate = photo.daily_log_id ? logDatesById.get(photo.daily_log_id) : undefined
    const key = linkedDate ?? format(parseISO(photo.created_at), "yyyy-MM-dd")
    const list = photosByDate.get(key) ?? []
    list.push(photo)
    photosByDate.set(key, list)
  }

  const logsByDate = new Map<string, DailyLog[]>()
  for (const log of dailyLogs) {
    const list = logsByDate.get(log.date) ?? []
    list.push(log)
    logsByDate.set(log.date, list)
  }

  const buckets = new Map<string, DayBucket>()
  const allKeys = new Set([...logsByDate.keys(), ...photosByDate.keys(), ...reportsByDate.keys()])

  for (const key of allKeys) {
    const logs = (logsByDate.get(key) ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at))
    const photos = photosByDate.get(key) ?? []

    const workEntries: DailyLogEntry[] = []
    const passedInspections: DailyLogEntry[] = []
    const failedInspections: DailyLogEntry[] = []
    const deliveries: DailyLogEntry[] = []
    const safety: DailyLogEntry[] = []
    const constraints: DailyLogEntry[] = []
    const taskUpdates: DailyLogEntry[] = []
    const punchUpdates: DailyLogEntry[] = []
    const tradeHours = new Map<string, number>()

    let totalHours = 0
    let commentCount = 0
    let mentionCount = 0
    let mentionsMe = false

    for (const log of logs) {
      for (const entry of log.entries ?? []) {
        switch (entry.entry_type) {
          case "work":
            workEntries.push(entry)
            if (entry.hours) {
              totalHours += entry.hours
              const trade = entry.trade?.trim() || "Unspecified"
              tradeHours.set(trade, (tradeHours.get(trade) ?? 0) + entry.hours)
            }
            break
          case "inspection":
            if (entry.inspection_result === "fail") failedInspections.push(entry)
            else passedInspections.push(entry)
            break
          case "delivery":
            deliveries.push(entry)
            break
          case "safety":
            safety.push(entry)
            break
          case "constraint":
            constraints.push(entry)
            break
          case "task_update":
            taskUpdates.push(entry)
            break
          case "punch_update":
            punchUpdates.push(entry)
            break
        }
      }

      const logMentions = log.mentions ?? []
      mentionCount += logMentions.length
      const comments = log.comments ?? []
      commentCount += comments.length
      if (currentUserId) {
        if (logMentions.some((m) => m.mentioned_user_id === currentUserId)) mentionsMe = true
        if (comments.some((c) => (c.mentions ?? []).some((m) => m.mentioned_user_id === currentUserId))) mentionsMe = true
      }
    }

    const report = reportsByDate.get(key)
    const weather = report?.weather ?? logs.find((l) => l.weather)?.weather
    const hoursByTrade = Array.from(tradeHours.entries())
      .map(([trade, hours]) => ({ trade, hours }))
      .sort((a, b) => b.hours - a.hours)

    const manpowerWorkers = (report?.manpower ?? []).reduce((sum, m) => sum + (m.workers ?? 0), 0)

    const weight =
      logs.length +
      workEntries.length +
      passedInspections.length +
      failedInspections.length +
      deliveries.length +
      (report?.manpower?.length ?? 0) +
      Math.min(photos.length, 6) * 0.5

    buckets.set(key, {
      key,
      date: parseISO(key),
      report,
      logs,
      photos,
      weather,
      manpowerWorkers,
      totalHours,
      hoursByTrade,
      workEntries,
      passedInspections,
      failedInspections,
      deliveries,
      safety,
      constraints,
      taskUpdates,
      punchUpdates,
      commentCount,
      mentionCount,
      hasAlert: failedInspections.length > 0,
      isRain: isRainWeather(weather) || report?.day_type === "rain_day",
      mentionsMe,
      weight,
    })
  }

  return buckets
}

// ---------------------------------------------------------------------------
// Completeness — a day-record has a knowable definition of done.
// ---------------------------------------------------------------------------

export interface DayCompleteness {
  /** Ordered so the ring always draws segments in the same position. */
  segments: { key: "weather" | "manpower" | "narrative" | "photos"; label: string; done: boolean }[]
  done: number
  total: number
  missing: string[]
}

export function dayCompleteness(bucket: DayBucket | undefined): DayCompleteness {
  const hasNarrative =
    !!bucket && (bucket.logs.some((l) => Boolean(l.notes?.trim())) || bucket.workEntries.length > 0)
  const segments: DayCompleteness["segments"] = [
    { key: "weather", label: "Weather", done: Boolean(bucket?.weather) },
    { key: "manpower", label: "Manpower", done: (bucket?.manpowerWorkers ?? 0) > 0 || (bucket?.report?.manpower?.length ?? 0) > 0 },
    { key: "narrative", label: "Narrative", done: hasNarrative },
    { key: "photos", label: "Photos", done: (bucket?.photos.length ?? 0) > 0 },
  ]
  const done = segments.filter((s) => s.done).length
  return { segments, done, total: segments.length, missing: segments.filter((s) => !s.done).map((s) => s.label) }
}

/** First line of the day's first narrative — what the rail leads with. */
export function daySummaryLine(bucket: DayBucket): string | undefined {
  for (const log of bucket.logs) {
    const line = log.notes?.trim().split("\n")[0]?.trim()
    if (line) return line
  }
  const work = bucket.workEntries.find((e) => e.description?.trim())
  return work?.description?.trim()
}

// ---------------------------------------------------------------------------
// Day spine — every calendar day from project start to today. The gap is data:
// an unlogged workday must be visible, not silently absent.
// ---------------------------------------------------------------------------

export type SpineRow =
  | { type: "month"; key: string; date: Date; logged: number; workdays: number }
  | { type: "day"; key: string; date: Date; bucket: DayBucket }
  | { type: "missed"; key: string; date: Date }
  | { type: "weekend"; key: string; from: Date; to: Date }
  | { type: "gap"; key: string; from: Date; to: Date; count: number }

/** Collapse runs of unlogged workdays longer than this into one expandable row. */
const GAP_COLLAPSE_AT = 4

export function buildDaySpine(
  buckets: Map<string, DayBucket>,
  today: Date,
  projectStartDate?: string,
  expandedGaps?: Set<string>,
): SpineRow[] {
  const todayKey = format(today, "yyyy-MM-dd")
  const earliestBucket = Array.from(buckets.keys()).sort()[0]
  const startKey = [projectStartDate, earliestBucket].filter((k): k is string => Boolean(k && k <= todayKey)).sort()[0] ?? todayKey

  // Walk backwards from today, batching consecutive quiet days.
  const rows: SpineRow[] = []
  let monthRows: SpineRow[] = []
  let monthKey = ""
  let monthLogged = 0
  let monthWorkdays = 0

  // Pending runs are collected newest-first (we iterate descending).
  let weekendRun: Date[] = []
  let missedRun: Date[] = []

  function flushWeekend() {
    if (weekendRun.length === 0) return
    const newest = weekendRun[0]
    const oldest = weekendRun[weekendRun.length - 1]
    monthRows.push({ type: "weekend", key: `wk-${format(oldest, "yyyy-MM-dd")}`, from: oldest, to: newest })
    weekendRun = []
  }

  function flushMissed() {
    if (missedRun.length === 0) return
    const newest = missedRun[0]
    const oldest = missedRun[missedRun.length - 1]
    const gapKey = `gap-${format(oldest, "yyyy-MM-dd")}`
    if (missedRun.length > GAP_COLLAPSE_AT && !expandedGaps?.has(gapKey)) {
      monthRows.push({ type: "gap", key: gapKey, from: oldest, to: newest, count: missedRun.length })
    } else {
      for (const date of missedRun) {
        monthRows.push({ type: "missed", key: format(date, "yyyy-MM-dd"), date })
      }
    }
    missedRun = []
  }

  function flushMonth() {
    if (!monthKey) return
    flushWeekend()
    flushMissed()
    rows.push({
      type: "month",
      key: `m-${monthKey}`,
      date: parseISO(`${monthKey}-01`),
      logged: monthLogged,
      workdays: monthWorkdays,
    })
    rows.push(...monthRows)
    monthRows = []
    monthLogged = 0
    monthWorkdays = 0
  }

  for (let date = parseISO(todayKey); ; date = addDays(date, -1)) {
    const key = format(date, "yyyy-MM-dd")
    if (key < startKey) break

    const mk = key.slice(0, 7)
    if (mk !== monthKey) {
      flushMonth()
      monthKey = mk
    }

    const bucket = buckets.get(key)
    const weekend = isWeekend(date)
    if (!weekend) {
      monthWorkdays += 1
      if (bucket) monthLogged += 1
    }

    if (bucket) {
      flushWeekend()
      flushMissed()
      monthRows.push({ type: "day", key, date, bucket })
    } else if (weekend) {
      flushMissed()
      weekendRun.push(date)
    } else if (key === todayKey) {
      // Today is never a "missed" accusation — it's simply not written yet.
      monthRows.push({ type: "missed", key, date })
    } else {
      flushWeekend()
      missedRun.push(date)
    }
  }
  flushMonth()

  return rows
}
