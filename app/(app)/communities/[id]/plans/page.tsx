import Link from "next/link"

import { getCommunityPriceSheet } from "@/lib/services/community-sales"

export const dynamic = "force-dynamic"

function money(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Number(cents ?? 0) / 100)
}

export default async function CommunityPlansPricingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const sheet = await getCommunityPriceSheet(id)
  return (
    <div>
      <div className="grid border-b sm:grid-cols-3">
        <div className="p-5 sm:border-r"><p className="text-2xl font-semibold tabular-nums">{sheet.rows.length}</p><p className="text-xs text-muted-foreground">Available plan elevations</p></div>
        <div className="p-5 sm:border-r"><p className="text-2xl font-semibold tabular-nums">{money(sheet.minPremiumCents)} – {money(sheet.maxPremiumCents)}</p><p className="text-xs text-muted-foreground">Available lot premiums</p></div>
        <div className="p-5"><p className="text-2xl font-semibold tabular-nums">{sheet.incentives.length}</p><p className="text-xs text-muted-foreground">Active incentives</p></div>
      </div>
      <div className="grid lg:grid-cols-[1fr_22rem]">
        <div className="overflow-x-auto border-b lg:border-b-0 lg:border-r">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs text-muted-foreground"><tr><th className="px-4 py-3">Plan</th><th className="px-4 py-3">Elevation</th><th className="px-4 py-3">Beds / baths</th><th className="px-4 py-3">Sq ft</th><th className="px-4 py-3">Base price</th><th className="px-4 py-3">From</th></tr></thead>
            <tbody>{sheet.rows.map((row: any, index: number) => <tr className="border-b" key={`${row.planId}:${row.elevationId ?? index}`}><td className="px-4 py-3"><Link className="font-medium hover:underline" href={`/plans/${row.planId}`}>{row.planCode ? `${row.planCode} · ` : ""}{row.planName}</Link></td><td className="px-4 py-3">{row.elevationName}</td><td className="px-4 py-3">{row.beds ?? "—"} / {row.baths ?? "—"}</td><td className="px-4 py-3 tabular-nums">{row.sqft?.toLocaleString() ?? "—"}</td><td className="px-4 py-3 tabular-nums">{money(row.basePriceCents)}</td><td className="px-4 py-3 tabular-nums">{money(row.fromPriceCents)}</td></tr>)}</tbody>
          </table>
          {sheet.rows.length === 0 ? <p className="p-8 text-center text-sm text-muted-foreground">No plans are currently released for this community.</p> : null}
        </div>
        <aside className="p-5">
          <h2 className="text-sm font-semibold">Active incentives</h2>
          <div className="mt-4 space-y-3">{sheet.incentives.map((item: any) => <div className="border-l-2 pl-3" key={item.id}><p className="text-sm font-medium">{item.name}</p><p className="text-xs text-muted-foreground">{item.amount_cents != null ? money(item.amount_cents) : item.percent != null ? `${item.percent}%` : item.incentive_type}</p></div>)}</div>
          {sheet.incentives.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No active incentives.</p> : null}
        </aside>
      </div>
    </div>
  )
}
