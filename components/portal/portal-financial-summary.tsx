"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { format } from "date-fns"
import type { PortalFinancialSummary } from "@/lib/types"

interface PortalFinancialSummaryProps {
  summary: PortalFinancialSummary
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100)
}

export function PortalFinancialSummaryCard({ summary }: PortalFinancialSummaryProps) {
  const paidPercent = summary.contractTotal > 0
    ? Math.round((summary.totalPaid / summary.contractTotal) * 100)
    : 0

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">Contract Total</span>
          <span className="text-lg font-semibold">{formatCurrency(summary.contractTotal)}</span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Paid</span>
            <span className="font-medium">{formatCurrency(summary.totalPaid)} ({paidPercent}%)</span>
          </div>
          <Progress value={paidPercent} className="h-2" />
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Remaining</span>
            <span className="font-medium">{formatCurrency(summary.balanceRemaining)}</span>
          </div>
        </div>

        {summary.nextDraw && (
          <div className="border-t pt-3 mt-3">
            <p className="text-sm font-medium">Next Draw: {summary.nextDraw.title}</p>
            <p className="text-sm text-muted-foreground">
              {formatCurrency(summary.nextDraw.amount_cents)}
              {summary.nextDraw.due_date && (
                <> · Due {format(new Date(summary.nextDraw.due_date), "MMM d, yyyy")}</>
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
