import type { DeadlineTone, LandDealStage } from "@/lib/land/diligence"

export function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

/** Dollars typed into a form, as integer cents. Blank is null. */
export function centsFromInput(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, "")
  if (!cleaned) return null
  const dollars = Number(cleaned)
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null
}

export function dollarsForInput(cents: number | null | undefined) {
  return cents == null ? "" : String(cents / 100)
}

export function shortDate(date: string | null | undefined) {
  if (!date) return "—"
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
}

/** "in 12d", "today", "9d late". */
export function relativeDays(days: number | null) {
  if (days == null) return null
  if (days === 0) return "today"
  return days > 0 ? `in ${days}d` : `${Math.abs(days)}d late`
}

/** The age ramp, by deadline pressure: fresh is quiet, aging warns, late is red. */
export const TONE_CLASS: Record<DeadlineTone, string> = {
  none: "text-muted-foreground",
  fresh: "text-muted-foreground",
  aging: "text-age-1",
  late: "font-medium text-destructive",
}

export const STAGE_TONE: Record<LandDealStage, string> = {
  screening: "border-border bg-muted text-muted-foreground",
  diligence: "border-primary/30 bg-primary/10 text-primary",
  in_review: "border-warning/40 bg-warning/10 text-warning",
  approved: "border-success/40 bg-success/10 text-success",
  acquired: "border-border bg-secondary text-secondary-foreground",
  dropped: "border-border bg-muted text-muted-foreground line-through",
}
