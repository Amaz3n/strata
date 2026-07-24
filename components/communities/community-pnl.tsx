import Link from "next/link"

import type { CommunityPnlRow } from "@/lib/services/production-reporting"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function CommunityPnl({ report }: { report: CommunityPnlRow | null }) {
  if (!report) {
    return <div className="p-8 text-sm text-muted-foreground">No financial data is available for this community yet.</div>
  }
  const stats = [
    ["Revenue + backlog", money(report.revenueCents)],
    ["Closed revenue", money(report.closedRevenueCents)],
    ["Direct-cost budget", money(report.budgetCents)],
    ["Actual direct cost", money(report.actualCostCents)],
    ["VPOs", money(report.vpoCents)],
    ["Projected margin", `${money(report.projectedMarginCents)} · ${report.projectedMarginPercent.toFixed(1)}%${report.targetMarginPercent != null ? ` vs ${report.targetMarginPercent.toFixed(1)}% target` : ""}`],
  ]
  return (
    <div className="space-y-0">
      <div className="grid border-b sm:grid-cols-3 xl:grid-cols-6">
        {stats.map(([label, value]) => (
          <div className="border-b p-5 sm:border-r xl:border-b-0" key={label}>
            <p className="text-xl font-semibold tabular-nums">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{label}</p>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground">
            <tr>
              {["Lot / home", "Plan", "Position", "Revenue", "Budget", "Actual", "VPO", "Projected margin"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {report.lots.map((row) => (
              <tr className="border-b" key={row.projectId}>
                <td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/projects/${row.projectId}`}>Lot {row.lotNumber} · {row.projectName}</Link></td>
                <td className="px-4 py-3">{row.planName}</td>
                <td className="px-4 py-3 capitalize">{row.status}</td>
                <td className="px-4 py-3 tabular-nums">{money(row.revenueCents)}</td>
                <td className="px-4 py-3 tabular-nums">{money(row.budgetCents)}</td>
                <td className="px-4 py-3 tabular-nums">{money(row.actualCostCents)}</td>
                <td className="px-4 py-3 tabular-nums">{money(row.vpoCents)}</td>
                <td className="px-4 py-3 tabular-nums">{money(row.projectedMarginCents)} · {row.projectedMarginPercent.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {report.lots.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">Link a home to a lot to begin community reporting.</p> : null}
      </div>
    </div>
  )
}
