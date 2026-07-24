import Link from "next/link"

import { ReportCsvButton } from "@/components/reports/report-csv-button"
import type { BacklogReportRow } from "@/lib/services/closings"
import type { CycleTimeRow } from "@/lib/services/even-flow"
import type { ProductionPortfolioReport } from "@/lib/services/production-reporting"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function ReportSection({ title, description, csv, children }: { title: string; description: string; csv: { filename: string; rows: Array<Record<string, string | number | null>> }; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between gap-4">
        <div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>
        <ReportCsvButton {...csv} />
      </div>
      <div className="overflow-x-auto border">{children}</div>
    </section>
  )
}

export function ProductionExecutiveReports({
  report,
  backlog,
  cycle,
  flow,
}: {
  report: ProductionPortfolioReport
  backlog: BacklogReportRow[]
  cycle: CycleTimeRow[]
  flow: Array<{ weekStart: string; plannedStarts: number; actualStarts: number }>
}) {
  return (
    <div className="space-y-10">
      <ReportSection
        title="Community P&L"
        description="Closed revenue, backlog, direct cost, VPO leakage, and projected margin."
        csv={{ filename: "community-pnl.csv", rows: report.communities.map((row) => ({ community: row.communityName, revenue_cents: row.revenueCents, closed_revenue_cents: row.closedRevenueCents, backlog_revenue_cents: row.backlogRevenueCents, direct_cost_budget_cents: row.budgetCents, actual_cost_cents: row.actualCostCents, vpo_cents: row.vpoCents, margin_cents: row.projectedMarginCents, margin_percent: Number(row.projectedMarginPercent.toFixed(2)) })) }}
      >
        <table className="w-full text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr>{["Community", "Homes", "Revenue", "Closed", "Backlog", "Direct cost", "VPO", "Margin"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{report.communities.map((row) => <tr className="border-b" key={row.communityId}><td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/communities/${row.communityId}/pnl`}>{row.communityName}</Link></td><td className="px-4 py-3 tabular-nums">{row.lotCount}</td><td className="px-4 py-3 tabular-nums">{money(row.revenueCents)}</td><td className="px-4 py-3 tabular-nums">{money(row.closedRevenueCents)}</td><td className="px-4 py-3 tabular-nums">{money(row.backlogRevenueCents)}</td><td className="px-4 py-3 tabular-nums">{money(Math.max(row.actualCostCents, row.budgetCents))}</td><td className="px-4 py-3 tabular-nums">{money(row.vpoCents)}</td><td className="px-4 py-3 tabular-nums">{money(row.projectedMarginCents)} · {row.projectedMarginPercent.toFixed(1)}%</td></tr>)}</tbody></table>
      </ReportSection>

      <div className="grid gap-8 xl:grid-cols-2">
        <ReportSection title="Margin by plan" description="Projected contribution across every community." csv={{ filename: "margin-by-plan.csv", rows: report.plans.map((row) => ({ plan: row.planName, homes: row.homes, revenue_cents: row.revenueCents, cost_cents: row.costCents, margin_cents: row.marginCents, margin_percent: Number(row.marginPercent.toFixed(2)) })) }}>
          <table className="w-full text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr>{["Plan", "Homes", "Revenue", "Cost", "Margin"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{report.plans.map((row) => <tr className="border-b" key={row.planId}><td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/plans/${row.planId}`}>{row.planName}</Link></td><td className="px-4 py-3">{row.homes}</td><td className="px-4 py-3">{money(row.revenueCents)}</td><td className="px-4 py-3">{money(row.costCents)}</td><td className="px-4 py-3">{money(row.marginCents)} · {row.marginPercent.toFixed(1)}%</td></tr>)}</tbody></table>
        </ReportSection>
        <ReportSection title="Variance leakage" description="Approved VPOs grouped by reason and trade." csv={{ filename: "vpo-variance.csv", rows: report.variance.map((row) => ({ reason: row.reason, trade: row.trade, count: row.count, amount_cents: row.amountCents, percent_of_direct_cost: Number(row.percentOfDirectCost.toFixed(2)) })) }}>
          <table className="w-full text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr>{["Reason", "Trade", "Count", "Amount", "% direct cost"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{report.variance.map((row) => <tr className="border-b" key={row.key}><td className="px-4 py-3">{row.reason}</td><td className="px-4 py-3">{row.trade}</td><td className="px-4 py-3">{row.count}</td><td className="px-4 py-3">{money(row.amountCents)}</td><td className="px-4 py-3">{row.percentOfDirectCost.toFixed(2)}%</td></tr>)}</tbody></table>
        </ReportSection>
      </div>

      <div className="grid gap-8 xl:grid-cols-2">
        <ReportSection title="Cycle time & even flow" description="Completed-home cycle time and weekly release adherence." csv={{ filename: "cycle-and-flow.csv", rows: [...cycle.map((row) => ({ group: row.groupLabel, completed_homes: row.count, median_days: row.medianDays, p80_days: row.p80Days, week: null, planned_starts: null, actual_starts: null })), ...flow.map((row) => ({ group: "Even flow", completed_homes: null, median_days: null, p80_days: null, week: row.weekStart, planned_starts: row.plannedStarts, actual_starts: row.actualStarts }))] }}>
          <table className="w-full text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr>{["Community", "Completed", "Median days", "P80 days"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{cycle.map((row) => <tr className="border-b" key={row.groupKey}><td className="px-4 py-3">{row.groupLabel}</td><td className="px-4 py-3">{row.count}</td><td className="px-4 py-3">{row.medianDays}</td><td className="px-4 py-3">{row.p80Days}</td></tr>)}</tbody></table>
        </ReportSection>
        <ReportSection title="Closing backlog" description="Sold-not-closed units, value, and 30-day horizon." csv={{ filename: "closing-backlog.csv", rows: backlog.map((row) => ({ community: row.community_name, spec_units: row.spec_units, backlog_units: row.backlog_units, backlog_value_cents: row.backlog_value_cents, scheduled_30d_units: row.scheduled_30d_units, closed_units_ytd: row.closed_units_ytd, closed_value_ytd_cents: row.closed_value_ytd_cents })) }}>
          <table className="w-full text-sm"><thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr>{["Community", "Spec", "Backlog", "Value", "Next 30d", "Closed YTD"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead><tbody>{backlog.map((row) => <tr className="border-b" key={row.community_id}><td className="px-4 py-3">{row.community_name}</td><td className="px-4 py-3">{row.spec_units}</td><td className="px-4 py-3">{row.backlog_units}</td><td className="px-4 py-3">{money(row.backlog_value_cents)}</td><td className="px-4 py-3">{row.scheduled_30d_units}</td><td className="px-4 py-3">{row.closed_units_ytd}</td></tr>)}</tbody></table>
        </ReportSection>
      </div>
    </div>
  )
}
