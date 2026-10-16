import type { DeliveryState } from "@/lib/services/po-receipts"

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  expected: "Expected",
  late: "Late",
  partial: "Partial",
  short: "Short",
  received: "Received",
  closed: "Closed out",
}

/** State colour reports state: late and short are what someone has to act on. */
export const DELIVERY_STATE_TONE: Record<DeliveryState, string> = {
  expected: "text-muted-foreground",
  late: "text-destructive",
  partial: "text-warning",
  short: "text-destructive",
  received: "text-success",
  closed: "text-muted-foreground",
}

const quantityFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })

export const formatQuantity = (value: number) => quantityFormat.format(value)

/** A calendar date (YYYY-MM-DD) is a day, not an instant: no timezone shift. */
export const formatDay = (date: string | null) => date ? dayFormat.format(new Date(`${date}T00:00:00Z`)) : "—"
