import { parseISO } from "date-fns"

import { cn } from "@/lib/utils"
import {
  PAY_APPLICATION_STAGE_LABELS,
  type PayApplicationStage,
} from "@/lib/financials/pay-app-lifecycle"

/**
 * Colour reports where the application stands, nothing else. The owner scans
 * this column first: one row is waiting on them, the rest are history.
 */
const STAGE_CLASS: Record<PayApplicationStage, string> = {
  draft: "border-border text-muted-foreground",
  returned: "border-destructive/40 bg-destructive/10 text-destructive",
  submitted: "border-border text-muted-foreground",
  awaiting_certification: "border-warning/40 bg-warning/10 text-warning",
  certified: "border-primary/40 bg-primary/10 text-primary",
  billed: "border-primary/40 bg-primary/10 text-primary",
  paid: "border-success/40 bg-success/10 text-success",
  void: "border-border text-muted-foreground",
}

export function PayApplicationStageBadge({
  stage,
  className,
}: {
  stage: PayApplicationStage
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex w-fit items-center border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        STAGE_CLASS[stage],
        className,
      )}
    >
      {PAY_APPLICATION_STAGE_LABELS[stage]}
    </span>
  )
}

/** `2026-03-31` is a calendar date, not an instant — parse it in local time. */
export function formatPortalDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = parseISO(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
}

export function formatPortalDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const date = parseISO(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

/** "Mar 1 – Mar 31, 2026", or just the end date when there is no start. */
export function formatBillingPeriod(start: string | null, end: string): string {
  const endLabel = formatPortalDate(end) ?? end
  if (!start) return `Through ${endLabel}`
  const startDate = parseISO(start)
  if (Number.isNaN(startDate.getTime())) return `Through ${endLabel}`
  const startLabel = startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return `${startLabel} – ${endLabel}`
}

export function payApplicationTitle(application: {
  application_number: number
  revision: number
  is_retainage_release: boolean
}): string {
  const base = application.is_retainage_release
    ? `Retainage release #${application.application_number}`
    : `Application #${application.application_number}`
  return application.revision > 0 ? `${base} · Rev ${application.revision}` : base
}
