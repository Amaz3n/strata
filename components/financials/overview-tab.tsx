"use client"

import type { Contract, DrawSchedule, Retainage, ScheduleItem } from "@/lib/types"
import type { ProjectStats } from "@/app/projects/[id]/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContractSummaryCard } from "@/components/projects/contract-summary-card"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"
import { RetainageTracker } from "@/components/projects/retainage-tracker"
import { Button } from "@/components/ui/button"
import { ArrowRight, TrendingUp, TrendingDown, DollarSign, Receipt, CreditCard, FileText } from "lucide-react"

interface OverviewTabProps {
  projectId: string
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  draws: DrawSchedule[]
  retainage: Retainage[]
  budgetSummary?: ProjectStats["budgetSummary"]
  scheduleItems?: ScheduleItem[]
  onNavigateToTab?: (tab: string) => void
}

export function OverviewTab({
  projectId,
  contract,
  approvedChangeOrdersTotalCents,
  draws,
  retainage,
  budgetSummary,
  scheduleItems,
  onNavigateToTab,
}: OverviewTabProps) {
  return (
    <div className="space-y-6">
      {/* Quick Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <QuickStatCard
          label="Contract Value"
          value={formatCurrency((contract?.total_cents ?? 0) + (approvedChangeOrdersTotalCents ?? 0))}
          icon={FileText}
          trend={approvedChangeOrdersTotalCents ? `+${formatCurrency(approvedChangeOrdersTotalCents)} changes` : undefined}
          trendUp={true}
        />
        <QuickStatCard
          label="Budget"
          value={formatCurrency(budgetSummary?.adjustedBudgetCents)}
          icon={DollarSign}
          trend={budgetSummary?.variancePercent ? `${budgetSummary.variancePercent}% used` : undefined}
          trendUp={(budgetSummary?.variancePercent ?? 0) < 90}
        />
        <QuickStatCard
          label="Invoiced"
          value={formatCurrency(budgetSummary?.totalInvoicedCents)}
          icon={Receipt}
          onClick={() => onNavigateToTab?.("receivables")}
        />
        <QuickStatCard
          label="Committed"
          value={formatCurrency(budgetSummary?.totalCommittedCents)}
          icon={CreditCard}
          onClick={() => onNavigateToTab?.("payables")}
        />
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => onNavigateToTab?.("budget")}>
          <DollarSign className="h-4 w-4 mr-2" />
          View Budget
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onNavigateToTab?.("receivables")}>
          <Receipt className="h-4 w-4 mr-2" />
          View Invoices
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onNavigateToTab?.("payables")}>
          <CreditCard className="h-4 w-4 mr-2" />
          View Payables
          <ArrowRight className="h-4 w-4 ml-2" />
        </Button>
      </div>

      {/* Main Content Grid */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ContractSummaryCard
          contract={contract}
          approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
        />
        <BudgetSummaryCard budgetSummary={budgetSummary} onViewDetails={() => onNavigateToTab?.("budget")} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DrawScheduleManager
          projectId={projectId}
          initialDraws={draws}
          contract={contract}
          approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents}
          scheduleItems={scheduleItems}
        />
        <RetainageTracker retainage={retainage} />
      </div>
    </div>
  )
}

function QuickStatCard({
  label,
  value,
  icon: Icon,
  trend,
  trendUp,
  onClick,
}: {
  label: string
  value: string
  icon: React.ComponentType<{ className?: string }>
  trend?: string
  trendUp?: boolean
  onClick?: () => void
}) {
  const Wrapper = onClick ? "button" : "div"

  return (
    <Card className={onClick ? "cursor-pointer hover:border-primary/50 transition-colors" : ""}>
      <Wrapper onClick={onClick} className="w-full text-left">
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className="text-2xl font-bold">{value}</p>
              {trend && (
                <div className="flex items-center gap-1 text-xs">
                  {trendUp !== undefined && (
                    trendUp ? (
                      <TrendingUp className="h-3 w-3 text-success" />
                    ) : (
                      <TrendingDown className="h-3 w-3 text-destructive" />
                    )
                  )}
                  <span className={trendUp ? "text-success" : trendUp === false ? "text-destructive" : "text-muted-foreground"}>
                    {trend}
                  </span>
                </div>
              )}
            </div>
            <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10">
              <Icon className="h-5 w-5 text-primary" />
            </div>
          </div>
        </CardContent>
      </Wrapper>
    </Card>
  )
}

function BudgetSummaryCard({
  budgetSummary,
  onViewDetails,
}: {
  budgetSummary?: ProjectStats["budgetSummary"]
  onViewDetails?: () => void
}) {
  if (!budgetSummary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Budget Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No budget data available.</p>
          {onViewDetails && (
            <Button variant="outline" size="sm" className="mt-3" onClick={onViewDetails}>
              Create Budget
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  const { adjustedBudgetCents, totalCommittedCents, totalActualCents, totalInvoicedCents, varianceCents, variancePercent } =
    budgetSummary

  const entries = [
    { label: "Adjusted budget", value: adjustedBudgetCents },
    { label: "Committed", value: totalCommittedCents },
    { label: "Actual", value: totalActualCents },
    { label: "Invoiced", value: totalInvoicedCents },
    { label: "Variance", value: varianceCents, extra: `${variancePercent}%`, isVariance: true },
  ]

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Budget Summary</CardTitle>
        {onViewDetails && (
          <Button variant="ghost" size="sm" onClick={onViewDetails}>
            View Details
            <ArrowRight className="h-4 w-4 ml-2" />
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm">
        {entries.map((entry) => (
          <div key={entry.label} className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{entry.label}</div>
            <div className={`font-semibold ${entry.isVariance && variancePercent > 100 ? "text-destructive" : ""}`}>
              {formatCurrency(entry.value)}
              {entry.extra ? <span className="ml-1 text-xs text-muted-foreground">({entry.extra})</span> : null}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function formatCurrency(cents?: number) {
  if (typeof cents !== "number") return "$0"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}
