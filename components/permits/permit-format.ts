import type { AgingState, PermitStage } from "@/lib/permits/lifecycle"

export function formatDay(value?: string | null) {
  if (!value) return "—"
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function addDaysIso(value: string, days: number) {
  return new Date(Date.parse(`${value}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Stage reports state: green when the house may build on it, amber while the builder owes a response, red when it cannot. */
export const STAGE_CLASS: Record<PermitStage, string> = {
  draft: "border-border text-muted-foreground",
  submitted: "border-primary/40 text-primary",
  corrections_requested: "border-warning/50 text-warning",
  approved: "border-success/40 text-success",
  not_required: "border-success/40 text-success",
  denied: "border-destructive/40 text-destructive",
  withdrawn: "border-border text-muted-foreground",
  expired: "border-destructive/40 text-destructive",
  superseded: "border-border text-muted-foreground",
}

export const AGING_CLASS: Record<AgingState, string> = {
  overdue: "font-medium text-destructive",
  due_soon: "text-warning",
  on_track: "text-muted-foreground",
}

export function dueLabel(daysOut: number) {
  if (daysOut < 0) return `${-daysOut}d late`
  if (daysOut === 0) return "Due today"
  return `${daysOut}d left`
}

/** Dollars typed by a person, as integer cents; null when it is not an amount. */
export function parseDollars(value: string) {
  const cleaned = value.replace(/[$,\s]/g, "")
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.round(Number(cleaned) * 100)
}
