import Link from "next/link"
import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { requireOrgContext } from "@/lib/services/context"
import { getChangeExposure } from "@/lib/services/change-orders"

export const dynamic = "force-dynamic"
const money = (cents: number) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

export default async function ChangeOrdersPage() {
  const context = await requireOrgContext()
  const { data: projects } = await context.supabase.from("projects").select("id,name,status").eq("org_id", context.orgId).is("archived_at", null).order("name").limit(500)
  const rows = (await Promise.all((projects ?? []).map(async (project) => ({ project, exposure: await getChangeExposure(project.id).catch(() => null) })))).filter((row) => row.exposure)
  const openEvent = rows.reduce((sum, row) => sum + (row.exposure?.open_event_exposure_cents ?? 0), 0)
  const pendingOrders = rows.reduce((sum, row) => sum + (row.exposure?.pending_cost_cents ?? 0), 0)
  return <PageLayout title="Change exposure" fullBleed><div className="space-y-5 p-4 sm:p-6 lg:p-8"><div className="grid border sm:grid-cols-3"><div className="border-b p-4 sm:border-b-0 sm:border-r"><p className="text-xs font-medium uppercase text-muted-foreground">Open event exposure</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(openEvent)}</p></div><div className="border-b p-4 sm:border-b-0 sm:border-r"><p className="text-xs font-medium uppercase text-muted-foreground">Pending change orders</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(pendingOrders)}</p></div><div className="p-4"><p className="text-xs font-medium uppercase text-muted-foreground">Total uncommitted</p><p className="mt-1 text-2xl font-semibold tabular-nums">{money(openEvent + pendingOrders)}</p></div></div><div className="overflow-hidden border"><Table><TableHeader><TableRow><TableHead>Project</TableHead><TableHead className="text-right">Events</TableHead><TableHead className="text-right">Pending COs</TableHead><TableHead className="text-right">Total</TableHead></TableRow></TableHeader><TableBody>{rows.sort((a,b) => ((b.exposure?.total_uncommitted_exposure_cents ?? 0) - (a.exposure?.total_uncommitted_exposure_cents ?? 0))).map(({ project, exposure }) => <TableRow key={project.id}><TableCell><Link className="font-medium hover:underline" href={`/projects/${project.id}/change-orders`}>{project.name}</Link><Badge variant="outline" className="ml-2 capitalize">{project.status}</Badge></TableCell><TableCell className="text-right tabular-nums">{money(exposure!.open_event_exposure_cents)}</TableCell><TableCell className="text-right tabular-nums">{money(exposure!.pending_cost_cents)}</TableCell><TableCell className="text-right font-medium tabular-nums">{money(exposure!.total_uncommitted_exposure_cents)}</TableCell></TableRow>)}</TableBody></Table></div></div></PageLayout>
}
