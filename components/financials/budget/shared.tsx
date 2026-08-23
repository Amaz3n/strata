"use client"

import { Info } from "lucide-react"

import type { CostType } from "@/lib/cost-types"
import type { BudgetLineRecord } from "@/lib/services/budgets"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type EditableBudgetLine = {
  id: string
  cost_code_id: string | null
  description: string
  amount_dollars: string
  cost_type: CostType | null
}

export type CostBucketDraft = {
  key?: string | null
  costCodeId: string | null
  description: string
  amountDollars: string
  lineIds?: string[]
}

export type CommitmentCreateDraft = {
  costCodeId: string | null
  budgetLineId: string | null
  defaultAmountDollars: string
  defaultScope: string
}

export type ReviewLine = {
  cost_code_id: string | null
  cost_code_label: string | null
  description: string
  amountDollars: string
  include: boolean
}

export type BuyoutChip = {
  package_count: number
  awarded_count: number
  open_count: number
  lowest_bid_cents?: number | null
} | null

/** One row of the unified budget table: a cost bucket with every money column. */
export interface UnifiedBudgetRow {
  key: string
  costCodeId: string | null
  code?: string
  name: string
  category?: string | null
  costType: CostType | null
  lines: EditableBudgetLine[]
  budgetCents: number
  baselineCents: number | null
  coAdjustmentCents: number
  adjustedBudgetCents: number
  committedCents: number
  committedBilledCents: number
  remainingCommitmentCents: number
  pendingCostCents: number
  exposureCents: number
  actualCents: number
  invoicedCents: number
  varianceCents: number
  /** Percent of adjusted budget already spent. */
  variancePercent: number
  status: string
  percentComplete: number | null
  eacCents: number
  costToCompleteCents: number
  varianceAtCompletionCents: number
  assignedCompanies: string[]
  buyout: BuyoutChip
}

export function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

export function formatCurrency(cents?: number | null, opts?: { compact?: boolean }) {
  if (typeof cents !== "number") return "—"
  const dollars = cents / 100
  if (opts?.compact && Math.abs(dollars) >= 1000) {
    return dollars.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    })
  }
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

export function toLineState(lines: BudgetLineRecord[] | undefined): EditableBudgetLine[] {
  return (lines ?? []).map((line) => {
    const costCode = Array.isArray(line.cost_code) ? line.cost_code[0] : line.cost_code
    return {
      id: line.id ?? crypto.randomUUID(),
      cost_code_id: line.cost_code_id ?? null,
      description: line.description ?? "",
      amount_dollars:
        typeof line.amount_cents === "number" ? String((line.amount_cents / 100).toFixed(2)) : "0",
      cost_type: line.cost_type ?? costCode?.cost_type ?? null,
    }
  })
}

/** A label with an info icon that reveals a plain-language definition on hover. */
export function Hint({ label, hint, className }: { label: string; hint: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1", className)}>
            {label}
            <Info className="h-3 w-3 opacity-50" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[220px] text-xs font-normal normal-case">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function SummaryMetric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border p-3">
      <span className="text-[11px] font-medium uppercase text-muted-foreground">
        {hint ? <Hint label={label} hint={hint} /> : label}
      </span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  )
}

export function CommitmentStatusBadge({ status }: { status?: string }) {
  const normalized = (status ?? "draft").toLowerCase()
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    approved: { label: "Approved", cls: "bg-success/10 text-success" },
    sent: { label: "Sent", cls: "bg-primary/10 text-primary" },
    complete: { label: "Complete", cls: "bg-muted text-muted-foreground" },
    canceled: { label: "Canceled", cls: "bg-destructive/10 text-destructive" },
    rejected: { label: "Rejected", cls: "bg-destructive/10 text-destructive" },
    voided: { label: "Voided", cls: "bg-destructive/10 text-destructive" },
  }
  const entry = map[normalized] ?? map.draft
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        entry.cls,
      )}
    >
      {entry.label}
    </span>
  )
}

export function formatBuyoutLabel(buyout?: BuyoutChip) {
  if (!buyout || buyout.package_count === 0) return "Not bought out"
  if (buyout.awarded_count > 0) return "Awarded"
  if (buyout.open_count > 0) return "Bidding"
  return `${buyout.package_count} package${buyout.package_count === 1 ? "" : "s"}`
}

export function buyoutClassName(buyout?: BuyoutChip) {
  if (!buyout || buyout.package_count === 0) return "border-border/60 text-muted-foreground"
  if (buyout.awarded_count > 0) return "border-success/30 bg-success/10 text-success"
  if (buyout.open_count > 0) return "border-primary/30 bg-primary/10 text-primary"
  return "border-warning/40 bg-warning/10 text-warning"
}

/** Parses a CSV string into rows of fields (handles quoted fields and commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0))
}
