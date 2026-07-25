import type { UnitAvailability } from "@/lib/services/community-sales"

export const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export function formatDay(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value.length <= 10 ? `${value.slice(0, 10)}T00:00:00` : value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

/** Compact "in 3d" / "6h left" / "2d overdue" from an ISO timestamp. */
export function formatCountdown(value: string | null | undefined): { label: string; overdue: boolean; soon: boolean } | null {
  if (!value) return null
  const ms = Date.parse(value) - Date.now()
  const overdue = ms < 0
  const abs = Math.abs(ms)
  const hours = Math.round(abs / 3_600_000)
  const days = Math.round(abs / 86_400_000)
  const magnitude = abs < 86_400_000 ? `${Math.max(1, hours)}h` : `${days}d`
  return {
    label: overdue ? `${magnitude} overdue` : `${magnitude} left`,
    overdue,
    soon: !overdue && abs <= 48 * 3_600_000,
  }
}

export interface BandMeta {
  key: UnitAvailability
  label: string
  /** CSS color token for the leading square + count. */
  swatch: string
  /** Sort weight — available first, then the funnel, closed last. */
  order: number
}

export const AVAILABILITY_BANDS: Record<UnitAvailability, BandMeta> = {
  available: { key: "available", label: "Available", swatch: "var(--muted-foreground)", order: 0 },
  held: { key: "held", label: "Held", swatch: "var(--age-1)", order: 1 },
  reserved: { key: "reserved", label: "Reserved", swatch: "var(--primary)", order: 2 },
  sold: { key: "sold", label: "Under contract", swatch: "var(--success)", order: 3 },
  closed: { key: "closed", label: "Closed", swatch: "var(--muted-foreground)", order: 4 },
}

/** Tone classes for the status pill in the table — color is state, never decoration. */
export const AVAILABILITY_BADGE: Record<UnitAvailability, string> = {
  available: "border-border bg-muted text-muted-foreground",
  held: "border-[var(--age-1)]/45 bg-[var(--age-1)]/12 text-[var(--age-1)]",
  reserved: "border-primary/35 bg-primary/10 text-primary",
  sold: "border-success/45 bg-success/12 text-success",
  closed: "border-border bg-muted text-muted-foreground",
}

export const UNIT_TYPE_LABEL: Record<string, string> = { spec: "Spec", tbb: "TBB", model: "Model" }
