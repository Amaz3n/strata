import { PageLayout } from "@/components/layout/page-layout"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getCycleTimeReport, getEvenFlowAdherence, getLateTaskHeatmap, getWipCounts } from "@/lib/services/even-flow"

export const dynamic = "force-dynamic"

export default async function StartsReportsPage() {
  const today = new Date()
  const fromDate = new Date(today)
  fromDate.setUTCDate(fromDate.getUTCDate() - 84)
  const from = fromDate.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)
  const [cycle, adherence, wip, heatmap] = await Promise.all([
    getCycleTimeReport({ groupBy: "community", from, to }),
    getEvenFlowAdherence({ from, to }),
    getWipCounts(),
    getLateTaskHeatmap(),
  ])
  const planned = adherence.reduce((sum, row) => sum + row.plannedStarts, 0)
  const actual = adherence.reduce((sum, row) => sum + row.actualStarts, 0)
  return <PageLayout title="Starts reports"><div className="space-y-8 p-4">
    <div className="flex flex-wrap gap-2">{[["WIP CSV", "wip"], ["Even-flow CSV", "even-flow"], ["Cycle-time CSV", "cycle-time"], ["Late tasks CSV", "late-tasks"]].map(([label, kind]) => <Button asChild key={kind} size="sm" variant="outline"><a href={`/api/reports/starts?kind=${kind}&from=${from}&to=${to}`}>{label}</a></Button>)}</div>
    <section><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Work in progress</h2><div className="grid gap-px bg-border sm:grid-cols-4">{wip.map((row) => <div className="bg-background p-4" key={row.communityId}><p className="text-xs text-muted-foreground">{row.communityName}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{row.underConstruction}</p><p className="text-xs text-muted-foreground">building · {row.precon} precon · {row.attention} attention</p></div>)}</div></section>
    <section><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">12-week even-flow</h2><p className="text-2xl font-semibold tabular-nums">{actual}/{planned}</p><p className="text-xs text-muted-foreground">actual starts against planned slots</p></section>
    <section><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Cycle time by community</h2><div className="border"><Table><TableHeader><TableRow><TableHead>Community</TableHead><TableHead>Homes</TableHead><TableHead>Median days</TableHead><TableHead>P80 days</TableHead></TableRow></TableHeader><TableBody>{cycle.length ? cycle.map((row) => <TableRow key={row.groupKey}><TableCell>{row.groupLabel}</TableCell><TableCell>{row.count}</TableCell><TableCell>{row.medianDays}</TableCell><TableCell>{row.p80Days}</TableCell></TableRow>) : <TableRow><TableCell colSpan={4} className="h-20 text-center text-muted-foreground">Completed production houses will appear here.</TableCell></TableRow>}</TableBody></Table></div></section>
    <section><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Late-task heatmap</h2><div className="border"><Table><TableHeader><TableRow><TableHead>Lot</TableHead><TableHead>Phase</TableHead><TableHead>Late tasks</TableHead><TableHead>Worst delay</TableHead></TableRow></TableHeader><TableBody>{heatmap.length ? heatmap.map((row) => <TableRow key={`${row.projectId}:${row.phase}`}><TableCell>{row.lotLabel}</TableCell><TableCell>{row.phase ?? "Unphased"}</TableCell><TableCell>{row.lateCount}</TableCell><TableCell>{row.maxDaysLate}d</TableCell></TableRow>) : <TableRow><TableCell colSpan={4} className="h-20 text-center text-muted-foreground">No late production schedule items.</TableCell></TableRow>}</TableBody></Table></div></section>
  </div></PageLayout>
}
