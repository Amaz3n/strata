import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { DollarSign, ChevronRight, TrendingUp, TrendingDown } from "@/components/icons"
import { cn } from "@/lib/utils"
import type { ProjectOverviewDTO } from "@/app/(app)/projects/[id]/overview-actions"

interface ProjectOverviewFinancialSnapshotProps {
  projectId: string
  budgetSummary?: ProjectOverviewDTO["budgetSummary"]
  contractTotalCents: number
  approvedChangeOrdersTotalCents: number
  nextDrawTitle: string | null
  nextDrawAmountCents: number | null
}

function formatCurrency(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

export function ProjectOverviewFinancialSnapshot({
  projectId,
  budgetSummary,
  contractTotalCents,
  approvedChangeOrdersTotalCents,
  nextDrawTitle,
  nextDrawAmountCents,
}: ProjectOverviewFinancialSnapshotProps) {
  const adjustedContractCents = contractTotalCents + approvedChangeOrdersTotalCents
  const hasContract = contractTotalCents > 0
  const hasBudget = budgetSummary && budgetSummary.adjustedBudgetCents > 0

  if (!hasContract && !hasBudget) {
    return null
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div className="space-y-1">
          <CardTitle className="text-sm font-medium">Financial Snapshot</CardTitle>
          <CardDescription>Contract and budget overview</CardDescription>
        </div>
        <Link href={`/projects/${projectId}/financials`}>
          <Button variant="ghost" size="sm" className="gap-1">
            View details
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key metrics grid */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Contract Total */}
          <div className="rounded-lg border bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">Contract Total</p>
            <p className="text-lg font-semibold">
              {hasContract ? formatCurrency(adjustedContractCents) : "Not set"}
            </p>
            {approvedChangeOrdersTotalCents > 0 && (
              <p className="text-xs text-muted-foreground">
                Incl. {formatCurrency(approvedChangeOrdersTotalCents)} in COs
              </p>
            )}
          </div>

          {/* Budget Used */}
          {hasBudget && (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Budget Used</p>
              <p className={cn(
                "text-lg font-semibold",
                budgetSummary.status === "over" && "text-destructive",
                budgetSummary.status === "warning" && "text-warning"
              )}>
                {budgetSummary.variancePercent}%
              </p>
              <p className="text-xs text-muted-foreground">
                {formatCurrency(budgetSummary.totalActualCents)} of {formatCurrency(budgetSummary.adjustedBudgetCents)}
              </p>
            </div>
          )}

          {/* Invoiced */}
          {hasBudget && (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Invoiced</p>
              <p className="text-lg font-semibold">
                {formatCurrency(budgetSummary.totalInvoicedCents)}
              </p>
              {budgetSummary.grossMarginPercent > 0 && (
                <p className="text-xs text-muted-foreground">
                  {budgetSummary.grossMarginPercent}% margin
                </p>
              )}
            </div>
          )}

          {/* Next Draw */}
          {nextDrawTitle && nextDrawAmountCents !== null && (
            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-xs text-muted-foreground">Next Draw</p>
              <p className="text-lg font-semibold">{formatCurrency(nextDrawAmountCents)}</p>
              <p className="text-xs text-muted-foreground truncate">{nextDrawTitle}</p>
            </div>
          )}
        </div>

        {/* Variance/Trend indicators */}
        {hasBudget && (
          <div className="flex flex-wrap gap-4 items-center text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Variance</span>
              <Badge
                variant="outline"
                className={cn(
                  budgetSummary.status === "over" && "border-destructive/40 text-destructive",
                  budgetSummary.status === "warning" && "border-amber-500/50 text-amber-500",
                  budgetSummary.status === "ok" && "border-emerald-500/40 text-emerald-600 dark:text-emerald-300"
                )}
              >
                {budgetSummary.variancePercent}% ({formatCurrency(budgetSummary.varianceCents)})
              </Badge>
            </div>

            <Separator orientation="vertical" className="h-6" />

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Gross margin</span>
              <span className="font-semibold">{budgetSummary.grossMarginPercent}%</span>
            </div>

            {typeof budgetSummary.trendPercent === "number" && (
              <>
                <Separator orientation="vertical" className="h-6" />
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Trend</span>
                  <span className={cn(
                    "flex items-center gap-1 font-semibold",
                    budgetSummary.trendPercent > 0 && "text-amber-500",
                    budgetSummary.trendPercent < 0 && "text-emerald-600 dark:text-emerald-300",
                    budgetSummary.trendPercent === 0 && "text-muted-foreground"
                  )}>
                    {budgetSummary.trendPercent > 0 ? (
                      <TrendingUp className="h-4 w-4" />
                    ) : budgetSummary.trendPercent < 0 ? (
                      <TrendingDown className="h-4 w-4" />
                    ) : null}
                    {Math.abs(Math.round(budgetSummary.trendPercent))}%
                  </span>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
