"use client"

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { ChevronDown, DollarSign, TrendingDown, TrendingUp } from "lucide-react"

// Helper function to format amounts
function formatCurrency(
  amount: number,
  options?: { minimumFractionDigits?: number; signDisplay?: "auto" | "always" | "never" }
): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: options?.minimumFractionDigits ?? 2,
    maximumFractionDigits: options?.minimumFractionDigits ?? 2,
    signDisplay: options?.signDisplay ?? "auto",
  }).format(amount)
}

interface BudgetSummaryData {
  total_budget_cents: number
  total_actual_cents: number
  variance_cents: number
  by_cost_code: Array<{
    cost_code_id: string | null
    cost_code_name?: string
    cost_code_number?: string
    budget_cents: number
    actual_cents: number
    item_count: number
  }>
}

interface BudgetSummaryPanelProps {
  projectId: string
  className?: string
  defaultOpen?: boolean
}

export function BudgetSummaryPanel({
  projectId,
  className,
  defaultOpen = false,
}: BudgetSummaryPanelProps) {
  const [budgetData, setBudgetData] = useState<BudgetSummaryData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isOpen, setIsOpen] = useState(defaultOpen)

  useEffect(() => {
    const fetchBudgetData = async () => {
      try {
        setLoading(true)
        const response = await fetch(`/api/schedule/budget-summary?projectId=${projectId}`)
        if (response.ok) {
          const data = await response.json()
          setBudgetData(data)
        }
      } catch (error) {
        console.error("Failed to fetch budget summary:", error)
      } finally {
        setLoading(false)
      }
    }

    if (projectId) {
      fetchBudgetData()
    }
  }, [projectId])

  if (loading) {
    return <BudgetSummaryPanelSkeleton className={className} />
  }

  if (!budgetData || budgetData.total_budget_cents === 0) {
    return null // Don't show if no budget data
  }

  const totalBudget = budgetData.total_budget_cents / 100
  const totalActual = budgetData.total_actual_cents / 100
  const totalVariance = budgetData.variance_cents / 100
  const percentSpent =
    totalBudget > 0 ? Math.min(100, (totalActual / totalBudget) * 100) : 0
  const isOverBudget = totalVariance < 0

  return (
    <Card className={cn("overflow-hidden", className)}>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full">
          <CardHeader className="pb-3 hover:bg-muted/50 transition-colors">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <DollarSign className="h-5 w-5 text-muted-foreground" />
                <CardTitle className="text-base">Budget Summary</CardTitle>
              </div>
              <div className="flex items-center gap-2">
                {!isOpen && (
                  <Badge
                    variant={isOverBudget ? "destructive" : "secondary"}
                    className="font-mono text-xs"
                  >
                    {formatCurrency(totalActual, { minimumFractionDigits: 0 })}{" "}
                    / {formatCurrency(totalBudget, { minimumFractionDigits: 0 })}
                  </Badge>
                )}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform",
                    isOpen && "rotate-180"
                  )}
                />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="space-y-4">
            {/* Overview Section */}
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Budget</p>
                  <p className="text-sm font-semibold font-mono">
                    {formatCurrency(totalBudget, { minimumFractionDigits: 0 })}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Actual</p>
                  <p className="text-sm font-semibold font-mono">
                    {formatCurrency(totalActual, { minimumFractionDigits: 0 })}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Variance</p>
                  <div className="flex items-center gap-1">
                    {isOverBudget ? (
                      <TrendingUp className="h-3.5 w-3.5 text-red-500" />
                    ) : (
                      <TrendingDown className="h-3.5 w-3.5 text-emerald-500" />
                    )}
                    <p
                      className={cn(
                        "text-sm font-semibold font-mono",
                        isOverBudget
                          ? "text-red-600 dark:text-red-400"
                          : "text-emerald-600 dark:text-emerald-400"
                      )}
                    >
                      {formatCurrency(totalVariance, { minimumFractionDigits: 0, signDisplay: "always" })}
                    </p>
                  </div>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">
                    {percentSpent.toFixed(1)}% spent
                  </span>
                  {isOverBudget && (
                    <Badge variant="destructive" className="text-[10px] h-4 px-1.5">
                      Over budget
                    </Badge>
                  )}
                </div>
                <Progress
                  value={percentSpent}
                  className={cn(
                    "h-2",
                    isOverBudget && "[&>div]:bg-red-500 dark:[&>div]:bg-red-600"
                  )}
                />
              </div>
            </div>

            {/* Cost Code Breakdown */}
            {budgetData.by_cost_code.length > 0 && (
              <div className="space-y-2 pt-2 border-t">
                <p className="text-xs font-medium text-muted-foreground">
                  By Cost Code
                </p>
                <div className="space-y-2">
                  {budgetData.by_cost_code.map((cc) => {
                    const budget = cc.budget_cents / 100
                    const actual = cc.actual_cents / 100
                    const variance = budget - actual
                    const ccIsOver = variance < 0
                    const ccPercentSpent =
                      budget > 0 ? Math.min(100, (actual / budget) * 100) : 0

                    return (
                      <div
                        key={cc.cost_code_id ?? "uncategorized"}
                        className="p-2.5 rounded-lg border bg-muted/30 space-y-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {cc.cost_code_number && (
                                <Badge
                                  variant="outline"
                                  className="shrink-0 font-mono text-[10px]"
                                >
                                  {cc.cost_code_number}
                                </Badge>
                              )}
                              <span className="text-sm font-medium truncate">
                                {cc.cost_code_name || "Uncategorized"}
                              </span>
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {cc.item_count} item{cc.item_count !== 1 ? "s" : ""}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-xs font-mono font-medium">
                              {formatCurrency(actual, { minimumFractionDigits: 0 })}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              of {formatCurrency(budget, { minimumFractionDigits: 0 })}
                            </p>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Progress
                            value={ccPercentSpent}
                            className={cn(
                              "h-1.5",
                              ccIsOver &&
                                "[&>div]:bg-red-500 dark:[&>div]:bg-red-600"
                            )}
                          />
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] text-muted-foreground">
                              {ccPercentSpent.toFixed(0)}%
                            </span>
                            <span
                              className={cn(
                                "text-[10px] font-medium font-mono",
                                ccIsOver
                                  ? "text-red-600 dark:text-red-400"
                                  : "text-emerald-600 dark:text-emerald-400"
                              )}
                            >
                              {formatCurrency(variance, { minimumFractionDigits: 0, signDisplay: "always" })}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

export function BudgetSummaryPanelSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Skeleton className="h-5 w-5 rounded" />
            <Skeleton className="h-4 w-32" />
          </div>
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      </CardHeader>
    </Card>
  )
}
