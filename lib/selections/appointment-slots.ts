/**
 * Design studio session times. A session is an instant range; a consultant's
 * hours and a studio's day are wall-clock times at the studio. Everything here
 * takes the studio's IANA zone explicitly -- never the server's or the
 * browser's -- so the slot picker, the service and the database
 * (`tg_design_studio_appointment_slot`) agree, including across a
 * daylight-saving change. Windows are half-open: a session ending at 12:00 and
 * the next starting at 12:00 are back to back.
 */

import { warrantyLocalDate } from "@/lib/services/warranty/visit-time"

export interface HoursWindow {
  /** 0 = Sunday, as `Date#getUTCDay` and Postgres `extract(dow)`. */
  weekday: number
  /** Minutes from local midnight. */
  startMinute: number
  endMinute: number
}

export interface Interval {
  start: string
  end: string
}

export interface LocalSlot {
  date: string
  weekday: number
  startMinute: number
  /** Past 1440 when the session runs past local midnight. */
  endMinute: number
}

const MINUTE_MS = 60_000

function zonedParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant)
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0)
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") }
}

/** How far the zone's wall clock is ahead of UTC at that instant, in minutes. */
function offsetMinutes(instant: Date, timeZone: string): number {
  const local = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / MINUTE_MS)
}

/** The instant a wall-clock time at the studio names ("2026-03-08", 600 → 10:00 that day). */
export function zonedTimeToUtc(date: string, minute: number, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number)
  const naive = Date.UTC(year, month - 1, day, 0, minute)
  const first = naive - offsetMinutes(new Date(naive), timeZone) * MINUTE_MS
  return new Date(naive - offsetMinutes(new Date(first), timeZone) * MINUTE_MS)
}

/** Where a session falls on the studio's wall clock. */
export function localSlot(interval: Interval, timeZone: string): LocalSlot {
  const start = new Date(interval.start)
  const end = new Date(interval.end)
  const date = warrantyLocalDate(interval.start, timeZone)
  const startParts = zonedParts(start, timeZone)
  const endParts = zonedParts(end, timeZone)
  const days = Math.round((Date.UTC(endParts.year, endParts.month - 1, endParts.day) - Date.UTC(startParts.year, startParts.month - 1, startParts.day)) / 86_400_000)
  const [year, month, day] = date.split("-").map(Number)
  return {
    date,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    startMinute: startParts.hour * 60 + startParts.minute,
    endMinute: days * 1440 + endParts.hour * 60 + endParts.minute,
  }
}

export function sessionInterval(startIso: string, durationMinutes: number): Interval {
  const start = new Date(startIso)
  return { start: start.toISOString(), end: new Date(start.getTime() + durationMinutes * MINUTE_MS).toISOString() }
}

function overlaps(a: Interval, b: Interval): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end)
}

/**
 * The first room in service with nothing booked over the window, in the
 * studio's room order. Null when every room is taken -- the studio is full.
 */
export function pickRoom(
  rooms: Array<{ id: string; isActive: boolean }>,
  bookings: Array<Interval & { roomId: string | null }>,
  interval: Interval,
): string | null {
  return rooms.find((room) => room.isActive && !bookings.some((booking) => booking.roomId === room.id && overlaps(booking, interval)))?.id ?? null
}

/**
 * A session never moves a deadline, and never lands after one: its local day
 * is on or before the earliest cutoff of the open groups it covers.
 */
export function sessionKeepsDeadlines(sessionDate: string, cutoffs: Array<string | null>): boolean {
  return cutoffs.every((cutoff) => cutoff === null || sessionDate <= cutoff)
}

export interface OpenSlot extends Interval {
  roomId: string
}

/**
 * Every start on the studio's day, on the step grid, where the consultant is
 * working and free, a room is free, the session ends inside the window, it is
 * still ahead of `now`, and it keeps every covered cutoff.
 */
export function openSlots(input: {
  date: string
  timeZone: string
  durationMinutes: number
  stepMinutes?: number
  windows: HoursWindow[]
  consultantBusy: Interval[]
  rooms: Array<{ id: string; isActive: boolean }>
  roomBookings: Array<Interval & { roomId: string | null }>
  cutoffs: Array<string | null>
  now: Date
}): OpenSlot[] {
  if (!sessionKeepsDeadlines(input.date, input.cutoffs)) return []
  const step = input.stepMinutes ?? 30
  const [year, month, day] = input.date.split("-").map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const slots: OpenSlot[] = []
  for (const window of input.windows.filter((candidate) => candidate.weekday === weekday)) {
    for (let minute = window.startMinute; minute + input.durationMinutes <= window.endMinute; minute += step) {
      const interval = sessionInterval(zonedTimeToUtc(input.date, minute, input.timeZone).toISOString(), input.durationMinutes)
      if (Date.parse(interval.start) <= input.now.getTime()) continue
      // A start that a daylight-saving jump moved onto another wall-clock time is not on the grid.
      if (localSlot(interval, input.timeZone).startMinute !== minute) continue
      if (input.consultantBusy.some((busy) => overlaps(busy, interval))) continue
      const roomId = pickRoom(input.rooms, input.roomBookings, interval)
      if (roomId) slots.push({ ...interval, roomId })
    }
  }
  return slots.sort((a, b) => a.start.localeCompare(b.start))
}

/** "9:00 AM" for minutes from midnight; "Midnight" for the end of the day. */
export function formatMinuteOfDay(minute: number): string {
  if (minute >= 1440) return "Midnight"
  const hour = Math.floor(minute / 60)
  const suffix = hour < 12 ? "AM" : "PM"
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute % 60).padStart(2, "0")} ${suffix}`
}

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const
