import Link from "next/link"

import { CommunitiesDeskTabs } from "@/components/communities/communities-desk-tabs"
import type { LandPortfolioRow } from "@/lib/services/production-reporting"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function LandPortfolio({ rows }: { rows: LandPortfolioRow[] }) {
  const cash = rows.reduce((total, row) => total + row.upcomingCashCents, 0)
  const lots = rows.reduce((total, row) => total + row.upcomingLots, 0)
  const deposits = rows.reduce((total, row) => total + row.depositsAtRiskCents, 0)
  return (
    <div>
      <CommunitiesDeskTabs active="land" />
      <div className="grid border-b sm:grid-cols-3">
        <div className="p-5 sm:border-r"><p className="text-2xl font-semibold tabular-nums">{money(cash)}</p><p className="text-xs text-muted-foreground">90-day takedown obligation</p></div>
        <div className="p-5 sm:border-r"><p className="text-2xl font-semibold tabular-nums">{lots}</p><p className="text-xs text-muted-foreground">Lots due in 90 days</p></div>
        <div className="p-5"><p className="text-2xl font-semibold tabular-nums">{money(deposits)}</p><p className="text-xs text-muted-foreground">Option deposits at risk</p></div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr>{["Community", "Next takedown", "Lots due", "Cash obligation", "Deposits at risk", "Available lots", "Starts · next 90", "Delivery coverage", "Starts · trailing 90", "Months of supply"].map((label) => <th className="px-4 py-3 font-medium" key={label}>{label}</th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr className="border-b" key={row.communityId}><td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/communities/${row.communityId}/land`}>{row.communityName}</Link></td><td className="px-4 py-3 tabular-nums">{row.nextTakedownDate ?? "—"}</td><td className="px-4 py-3 tabular-nums">{row.upcomingLots}</td><td className="px-4 py-3 tabular-nums">{money(row.upcomingCashCents)}</td><td className="px-4 py-3 tabular-nums">{money(row.depositsAtRiskCents)}</td><td className="px-4 py-3 tabular-nums">{row.availableLots}</td><td className="px-4 py-3 tabular-nums">{row.plannedStarts90}</td><td className={`px-4 py-3 tabular-nums ${row.deliveryCoverageLots < 0 ? "text-destructive" : ""}`}>{row.deliveryCoverageLots >= 0 ? `+${row.deliveryCoverageLots}` : row.deliveryCoverageLots}</td><td className="px-4 py-3 tabular-nums">{row.startsTrailing90}</td><td className="px-4 py-3 tabular-nums">{row.monthsOfSupply == null ? "No trailing starts" : row.monthsOfSupply.toFixed(1)}</td></tr>)}</tbody>
        </table>
        {rows.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">No communities match the current division.</p> : null}
      </div>
    </div>
  )
}
