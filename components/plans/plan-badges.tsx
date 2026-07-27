import { Badge } from "@/components/ui/badge"
import type { PlanPricingSource } from "@/lib/financials/plan-pricing"
import { cn } from "@/lib/utils"

const PLAN_TONES: Record<string, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  active: "border-primary/30 bg-primary/10 text-primary",
  retired: "border-border bg-secondary text-secondary-foreground",
  released: "border-primary/30 bg-primary/10 text-primary",
  superseded: "border-border bg-secondary text-secondary-foreground",
}

export function PlanStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("rounded-none text-[10px] font-medium uppercase tracking-wide", PLAN_TONES[status])}>
      {status.replaceAll("_", " ")}
    </Badge>
  )
}

const SOURCE_META: Record<PlanPricingSource, { label: string; tone: string }> = {
  price_agreement: { label: "Price book", tone: "border-primary/30 bg-primary/10 text-primary" },
  takeoff_manual: { label: "Manual", tone: "border-border bg-muted text-muted-foreground" },
  cost_code_default: { label: "Code default", tone: "border-border bg-secondary text-secondary-foreground" },
  unpriced: { label: "Unpriced", tone: "border-destructive/30 bg-destructive/10 text-destructive" },
}

export function PricingSourceBadge({ source }: { source: PlanPricingSource }) {
  const meta = SOURCE_META[source]
  return (
    <Badge variant="outline" className={cn("rounded-none px-1.5 text-[10px] font-medium uppercase tracking-wide", meta.tone)}>
      {meta.label}
    </Badge>
  )
}

export function centsToMoney(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/** Whole dollars. Nobody prices a house to the cent, and the decimals cost two columns. */
export function centsToDollars(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

/** Short form for axis labels and price bands: $385k, $1.24M. */
export function centsToCompact(cents: number): string {
  const dollars = cents / 100
  if (Math.abs(dollars) >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(2)}M`
  return `$${Math.round(dollars / 1000).toLocaleString()}k`
}

export function signedDollars(cents: number): string {
  return `${cents >= 0 ? "+" : "−"}${centsToDollars(Math.abs(cents))}`
}
