import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { listStartPackages } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartsPipelinePage() {
  const result = await listStartPackages({ pageSize: 200 })
  return <PageLayout title="Start pipeline" fullBleed><div className="p-4"><div className="border"><Table>
    <TableHeader><TableRow><TableHead>Community / lot</TableHead><TableHead>Status</TableHead><TableHead>Gates</TableHead><TableHead>Target week</TableHead><TableHead>Precon age</TableHead><TableHead>Superintendent</TableHead></TableRow></TableHeader>
    <TableBody>{result.packages.length ? result.packages.map((pkg) => <TableRow key={pkg.id}><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/starts/pipeline/${pkg.id}`}>{pkg.communityName} · {pkg.lotLabel}</Link></TableCell><TableCell className="capitalize">{pkg.status}</TableCell><TableCell className="tabular-nums">{pkg.gatesPassed}/{pkg.gatesTotal}</TableCell><TableCell>{pkg.targetWeek ?? "—"}</TableCell><TableCell className="tabular-nums">{pkg.preconAgeDays}d</TableCell><TableCell>{pkg.superintendentName ?? "Unassigned"}</TableCell></TableRow>) : <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">No start packages.</TableCell></TableRow>}</TableBody>
  </Table></div></div></PageLayout>
}
