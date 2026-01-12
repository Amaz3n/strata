import type { Contract, DrawSchedule, Retainage, ScheduleItem } from "@/lib/types"
import type { ProjectStats } from "@/app/(app)/projects/[id]/actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ContractSummaryCard } from "@/components/projects/contract-summary-card"
import { DrawScheduleManager } from "@/components/projects/draw-schedule-manager"
import { RetainageTracker } from "@/components/projects/retainage-tracker"

interface FinancialsTabProps {
  projectId: string
  contract: Contract | null
  approvedChangeOrdersTotalCents?: number
  draws: DrawSchedule[]
  retainage: Retainage[]
  budgetSummary?: ProjectStats["budgetSummary"]
  scheduleItems?: ScheduleItem[]
  onViewContract?: () => void
}

export function FinancialsTab({
  projectId,
  contract,
  approvedChangeOrdersTotalCents,
  draws,
  retainage,
  budgetSummary,
  scheduleItems,
  onViewContract,
}: FinancialsTabProps) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ContractSummaryCard contract={contract} approvedChangeOrdersTotalCents={approvedChangeOrdersTotalCents} onView={onViewContract} />
        <BudgetSummaryCard budgetSummary={budgetSummary} />
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

function BudgetSummaryCard({ budgetSummary }: { budgetSummary?: ProjectStats["budgetSummary"] }) {
  if (!budgetSummary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Budget Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No budget data available.</p>
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
    { label: "Variance", value: varianceCents, extra: `${variancePercent}%` },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Budget Summary</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-4 text-sm">
        {entries.map((entry) => (
          <div key={entry.label} className="space-y-1">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{entry.label}</div>
            <div className="font-semibold">
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
  if (typeof cents !== "number") return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}
