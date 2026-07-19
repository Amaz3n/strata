import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { getBacklogReport, listClosings } from "@/lib/services/closings"
import { listSpecInventory } from "@/lib/services/community-sales"

export const dynamic = "force-dynamic"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export default async function SalesPage() {
  const in90 = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10)
  const [backlog, closings, specs] = await Promise.all([
    getBacklogReport(),
    listClosings({ from: new Date().toISOString().slice(0, 10), to: in90, limit: 100 }),
    listSpecInventory({ limit: 100 }),
  ])
  const totals = (backlog as any[]).reduce((result, row) => ({ units: result.units + Number(row.backlog_units ?? 0), value: result.value + Number(row.backlog_value_cents ?? 0), closed: result.closed + Number(row.closed_units_ytd ?? 0) }), { units: 0, value: 0, closed: 0 })
  return <PageLayout title="Sales" fullBleed><div className="space-y-5 p-4">
    <div className="grid gap-3 sm:grid-cols-3">
      <Metric label="Backlog units" value={String(totals.units)} />
      <Metric label="Backlog value" value={money.format(totals.value / 100)} />
      <Metric label="Closed YTD" value={String(totals.closed)} />
    </div>
    <section className="overflow-hidden rounded-lg border bg-background"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Community backlog</h2></div><div className="overflow-x-auto"><table className="w-full text-xs"><thead className="bg-muted/40 text-left text-muted-foreground"><tr><th className="px-4 py-2">Community</th><th className="px-4 py-2 text-right">Specs</th><th className="px-4 py-2 text-right">Reserved</th><th className="px-4 py-2 text-right">Backlog</th><th className="px-4 py-2 text-right">Value</th><th className="px-4 py-2 text-right">Closed YTD</th></tr></thead><tbody>{(backlog as any[]).map((row) => <tr key={row.community_id} className="border-t"><td className="px-4 py-2.5 font-medium"><Link className="hover:underline" href={`/communities/${row.community_id}/sales`}>{row.community_name}</Link></td><td className="px-4 py-2.5 text-right">{row.spec_units}</td><td className="px-4 py-2.5 text-right">{row.reserved_units}</td><td className="px-4 py-2.5 text-right">{row.backlog_units}</td><td className="px-4 py-2.5 text-right">{money.format(Number(row.backlog_value_cents ?? 0) / 100)}</td><td className="px-4 py-2.5 text-right">{row.closed_units_ytd}</td></tr>)}</tbody></table></div></section>
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="overflow-hidden rounded-lg border bg-background"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Upcoming closings · 90 days</h2></div><div className="divide-y">{closings.closings.length ? closings.closings.map((row: any) => <Link key={row.id} href={`/projects/${row.project_id}/closing`} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-muted/30"><div><p className="font-medium">{row.project?.name ?? "Home"}</p><p className="text-xs text-muted-foreground">{row.community?.name} · Lot {row.lot?.lot_number}</p></div><div className="text-right"><Badge variant="outline">{String(row.status).replaceAll("_", " ")}</Badge><p className="mt-1 text-xs text-muted-foreground">{row.scheduled_date ?? "Projected"}</p></div></Link>) : <Empty text="No closings in the next 90 days." />}</div></section>
      <section className="overflow-hidden rounded-lg border bg-background"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Available specs</h2></div><div className="divide-y">{specs.length ? specs.slice(0, 20).map((row: any) => <Link key={row.lotId} href={`/projects/${row.projectId}`} className="flex items-center justify-between px-4 py-3 hover:bg-muted/30"><div><p className="font-medium">{row.communityName} · Lot {row.lotLabel}</p><p className="text-xs text-muted-foreground">{row.planLabel} · {row.agingDays} days</p></div><p className="font-medium tabular-nums">{money.format(row.askingPriceCents / 100)}</p></Link>) : <Empty text="No unsold specs." />}</div></section>
    </div>
  </div></PageLayout>
}

function Metric({ label, value }: { label: string; value: string }) { return <div className="rounded-lg border bg-background px-4 py-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p></div> }
function Empty({ text }: { text: string }) { return <p className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</p> }
