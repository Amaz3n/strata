"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { listUnbilledCostsAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

export type UnbilledCost = {
  id: string
  occurredOn: string
  description: string
  sourceType: string
  costCodeId: string | null
  costCode: string | null
  costCodeName: string | null
  costCents: number
  markupCents: number
  markupPercent: number
  billableCents: number
}

export type CostSelection = {
  billableCostIds: string[]
  groupBy: "cost_code" | "detail"
  dateRange: { from: string; to: string }
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | undefined
  costCodesEnabled?: boolean
  onConfirm: (selection: CostSelection) => Promise<void> | void
}

const COLS_WITH_CODES = "grid-cols-[28px_92px_88px_minmax(0,1fr)_96px_96px_104px]"
const COLS_WITHOUT_CODES = "grid-cols-[28px_92px_minmax(0,1fr)_96px_96px_104px]"

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function sourceLabel(sourceType: string) {
  switch (sourceType) {
    case "bill":
      return "Bill"
    case "expense":
      return "Expense"
    case "time":
      return "Time"
    case "allowance_overage":
      return "Allowance"
    default:
      return sourceType ? sourceType.replace(/_/g, " ") : "Cost"
  }
}

export function UnbilledCostsPicker({ open, onOpenChange, projectId, costCodesEnabled = true, onConfirm }: Props) {
  const [costs, setCosts] = useState<UnbilledCost[]>([])
  const [loading, setLoading] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState<"cost_code" | "detail">(costCodesEnabled ? "cost_code" : "detail")
  const [dateFrom, setDateFrom] = useState("")
  const [dateTo, setDateTo] = useState("")

  useEffect(() => {
    if (!costCodesEnabled) setGroupBy("detail")
  }, [costCodesEnabled])

  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    setLoading(true)
    setSelectedIds(new Set())
    setDateFrom("")
    setDateTo("")
    listUnbilledCostsAction(projectId)
      .then((res) => {
        if (!cancelled) setCosts((unwrapAction(res).costs as UnbilledCost[]) ?? [])
      })
      .catch((error: any) => {
        if (cancelled) return
        setCosts([])
        toast.error("Couldn't load unbilled costs", { description: error?.message ?? "Try again." })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  const filtered = useMemo(
    () =>
      costs.filter((cost) => {
        if (dateFrom && cost.occurredOn < dateFrom) return false
        if (dateTo && cost.occurredOn > dateTo) return false
        return true
      }),
    [costs, dateFrom, dateTo],
  )

  const selectedCosts = useMemo(() => costs.filter((cost) => selectedIds.has(cost.id)), [costs, selectedIds])
  const totals = useMemo(
    () =>
      selectedCosts.reduce(
        (acc, cost) => {
          acc.cost += cost.costCents
          acc.markup += cost.markupCents
          acc.billable += cost.billableCents
          return acc
        },
        { cost: 0, markup: 0, billable: 0 },
      ),
    [selectedCosts],
  )

  const allFilteredSelected = filtered.length > 0 && filtered.every((cost) => selectedIds.has(cost.id))
  const someFilteredSelected = filtered.some((cost) => selectedIds.has(cost.id))

  const toggleAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        filtered.forEach((cost) => next.delete(cost.id))
      } else {
        filtered.forEach((cost) => next.add(cost.id))
      }
      return next
    })
  }

  const toggleOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleConfirm = async () => {
    if (selectedIds.size === 0 || confirming) return
    setConfirming(true)
    try {
      const today = format(new Date(), "yyyy-MM-dd")
      await onConfirm({
        billableCostIds: [...selectedIds],
        groupBy: costCodesEnabled ? groupBy : "detail",
        dateRange: { from: dateFrom || "1970-01-01", to: dateTo || today },
      })
      onOpenChange(false)
    } catch {
      // The composer surfaces its own error toast; keep the dialog open so the selection isn't lost.
    } finally {
      setConfirming(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="space-y-1 border-b px-5 py-4">
          <DialogTitle className="text-base">Bill unbilled costs</DialogTitle>
          <DialogDescription>
            Select the costs to add. Markup is applied automatically, and selected costs are marked billed when you save.
          </DialogDescription>
        </DialogHeader>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 border-b px-5 py-3">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-muted-foreground">From</span>
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 w-[140px] text-sm"
            />
            <span className="text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-8 w-[140px] text-sm"
            />
          </div>
          {costCodesEnabled ? <div className="ml-auto inline-flex border border-input">
            <button
              type="button"
              onClick={() => setGroupBy("cost_code")}
              className={cn(
                "h-8 px-3 text-xs transition-colors",
                groupBy === "cost_code" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              By cost code
            </button>
            <button
              type="button"
              onClick={() => setGroupBy("detail")}
              className={cn(
                "h-8 border-l border-input px-3 text-xs transition-colors",
                groupBy === "detail" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
              )}
            >
              Detailed
            </button>
          </div> : null}
        </div>

        {/* Column headers */}
        <div
          className={cn(
            "grid items-center gap-x-2 border-b bg-muted/30 px-5 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70",
            costCodesEnabled ? COLS_WITH_CODES : COLS_WITHOUT_CODES,
          )}
        >
          <Checkbox
            checked={allFilteredSelected ? true : someFilteredSelected ? "indeterminate" : false}
            onCheckedChange={toggleAll}
            disabled={filtered.length === 0}
            aria-label="Select all"
            className="size-4 rounded-[2px]"
          />
          <span>Date</span>
          {costCodesEnabled ? <span>Cost code</span> : null}
          <span>Description</span>
          <span className="text-right">Cost</span>
          <span className="text-right">Markup</span>
          <span className="text-right">Billable</span>
        </div>

        {/* Rows */}
        <ScrollArea className="min-h-[200px] flex-1">
          {loading ? (
            <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
              <Spinner className="mr-2 size-4" />
              Loading costs…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-40 items-center justify-center px-5 text-center text-sm text-muted-foreground">
              {costs.length === 0 ? "No unbilled costs for this project yet." : "No costs in this date range."}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {filtered.map((cost) => {
                const checked = selectedIds.has(cost.id)
                return (
                  <label
                    key={cost.id}
                    className={cn(
                      "grid cursor-pointer items-center gap-x-2 px-5 py-2 text-sm transition-colors hover:bg-muted/30",
                      costCodesEnabled ? COLS_WITH_CODES : COLS_WITHOUT_CODES,
                      checked && "bg-muted/40",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggleOne(cost.id)}
                      className="size-4 rounded-[2px]"
                      aria-label={`Select ${cost.description || sourceLabel(cost.sourceType)}`}
                    />
                    <span className="tabular-nums text-muted-foreground">
                      {cost.occurredOn ? format(new Date(cost.occurredOn), "MMM d") : "—"}
                    </span>
                    {costCodesEnabled ? <span className="truncate text-muted-foreground">{cost.costCode ?? "—"}</span> : null}
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{cost.description || sourceLabel(cost.sourceType)}</span>
                      <span className="shrink-0 rounded-none border border-border/60 px-1 text-[9px] uppercase tracking-wide text-muted-foreground/70">
                        {sourceLabel(cost.sourceType)}
                      </span>
                    </span>
                    <span className="text-right tabular-nums text-muted-foreground">{formatMoney(cost.costCents)}</span>
                    <span className="text-right tabular-nums text-muted-foreground">
                      {formatMoney(cost.markupCents)}
                    </span>
                    <span className="text-right font-medium tabular-nums">{formatMoney(cost.billableCents)}</span>
                  </label>
                )
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="flex-row items-center justify-between gap-4 border-t px-5 py-3 sm:justify-between">
          <div className="text-sm">
            <span className="font-medium">{selectedIds.size}</span>
            <span className="text-muted-foreground"> selected · </span>
            <span className="font-semibold tabular-nums">{formatMoney(totals.billable)}</span>
            {totals.markup > 0 && (
              <span className="text-muted-foreground"> ({formatMoney(totals.markup)} markup)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" className="h-8 rounded-none" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-8 rounded-none"
              disabled={selectedIds.size === 0 || confirming}
              onClick={handleConfirm}
            >
              {confirming ? <Spinner className="mr-1.5 size-3.5" /> : null}
              Add to invoice
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
