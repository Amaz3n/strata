"use client"

import { useMemo } from "react"
import { AlertTriangle } from "lucide-react"

import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { formatCurrency } from "./shared"

type CashFlowRow = {
  label: string
  spendCents: number
  billingCents: number
  netCents: number
  cumulativeCents: number
}

/**
 * Straight-line cash-flow forecast. Spreads remaining cost (cost-to-complete)
 * and remaining billing evenly across the months left in the project schedule,
 * then shows net and cumulative cash position so crunch months stand out. This
 * is a projection, not a committed draw schedule.
 */
export function CashFlowDialog({
  open,
  onOpenChange,
  startDate,
  endDate,
  remainingCostCents,
  contractValueCents,
  contractBilledCents,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  startDate: string | null
  endDate: string | null
  remainingCostCents: number
  contractValueCents: number
  contractBilledCents: number
}) {
  const forecast = useMemo(() => {
    if (!endDate) return null
    const end = new Date(endDate)
    if (Number.isNaN(end.getTime())) return null

    const now = new Date()
    const start = startDate ? new Date(startDate) : now
    const firstMonth = new Date(Math.max(now.getTime(), Number.isNaN(start.getTime()) ? now.getTime() : start.getTime()))
    firstMonth.setDate(1)
    firstMonth.setHours(0, 0, 0, 0)
    const lastMonth = new Date(end.getFullYear(), end.getMonth(), 1)
    if (lastMonth < firstMonth) return null

    const months: Date[] = []
    const cursor = new Date(firstMonth)
    while (cursor <= lastMonth && months.length < 60) {
      months.push(new Date(cursor))
      cursor.setMonth(cursor.getMonth() + 1)
    }
    const n = months.length
    if (n === 0) return null

    const remainingBilling = Math.max(0, contractValueCents - contractBilledCents)
    const spendPer = Math.round(remainingCostCents / n)
    const billPer = Math.round(remainingBilling / n)

    let cumulative = 0
    const rows: CashFlowRow[] = months.map((month, index) => {
      const isLast = index === n - 1
      const spend = isLast ? remainingCostCents - spendPer * (n - 1) : spendPer
      const billing = isLast ? remainingBilling - billPer * (n - 1) : billPer
      const net = billing - spend
      cumulative += net
      return {
        label: month.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        spendCents: spend,
        billingCents: billing,
        netCents: net,
        cumulativeCents: cumulative,
      }
    })

    const peakSpend = Math.max(1, ...rows.map((row) => row.spendCents))
    const lowestCumulative = Math.min(...rows.map((row) => row.cumulativeCents))
    return { rows, peakSpend, remainingBilling, lowestCumulative }
  }, [startDate, endDate, remainingCostCents, contractValueCents, contractBilledCents])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Cash flow forecast</DialogTitle>
          <DialogDescription>
            Remaining cost and billing spread evenly across the months left in the schedule. A
            projection to spot crunch months — not a committed draw schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {!forecast ? (
            <div className="border border-dashed py-10 text-center text-sm text-muted-foreground">
              Add project start and end dates to forecast cash flow.
            </div>
          ) : (
            <div className="space-y-3">
              {forecast.lowestCumulative < 0 && (
                <div className="flex items-start gap-2 border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Projected cash dips to {formatCurrency(forecast.lowestCumulative)} — you may need to
                  bill earlier or carry the gap.
                </div>
              )}
              <div className="overflow-hidden border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="px-4">Month</TableHead>
                      <TableHead className="px-4">Spend</TableHead>
                      <TableHead className="w-[110px] px-4 text-right">Billing</TableHead>
                      <TableHead className="w-[110px] px-4 text-right">Net</TableHead>
                      <TableHead className="w-[120px] px-4 text-right">Cumulative</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecast.rows.map((row) => (
                      <TableRow key={row.label}>
                        <TableCell className="px-4 text-sm font-medium">{row.label}</TableCell>
                        <TableCell className="px-4">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-foreground/60"
                                style={{ width: `${Math.round((row.spendCents / forecast.peakSpend) * 100)}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {formatCurrency(row.spendCents, { compact: true })}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 text-right text-sm tabular-nums text-muted-foreground">
                          {formatCurrency(row.billingCents, { compact: true })}
                        </TableCell>
                        <TableCell className="px-4 text-right text-sm tabular-nums">
                          <span className={cn(row.netCents < 0 ? "text-destructive" : "text-success")}>
                            {formatCurrency(row.netCents, { compact: true })}
                          </span>
                        </TableCell>
                        <TableCell className="px-4 text-right text-sm font-medium tabular-nums">
                          <span className={cn(row.cumulativeCents < 0 ? "text-destructive" : "")}>
                            {formatCurrency(row.cumulativeCents, { compact: true })}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">
                Based on {formatCurrency(remainingCostCents)} remaining cost and{" "}
                {formatCurrency(forecast.remainingBilling)} left to bill over {forecast.rows.length}{" "}
                {forecast.rows.length === 1 ? "month" : "months"}.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
