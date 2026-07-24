import Link from "next/link"

import { PageLayout } from "@/components/layout/page-layout"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getCycleTimeReport, getEvenFlowAdherence, getLateTaskHeatmap, getWipCounts } from "@/lib/services/even-flow"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

const GROUPS = [
  ["community", "By community"],
  ["plan", "By plan"],
  ["superintendent", "By superintendent"],
] as const

type GroupBy = (typeof GROUPS)[number][0]

export default async function StartsReportsPage({ searchParams }: { searchParams: Promise<{ group?: string }> }) {
  const params = await searchParams
  const groupBy: GroupBy = params.group === "plan" || params.group === "superintendent" ? params.group : "community"
  const today = new Date()
  const fromDate = new Date(today)
  fromDate.setUTCDate(fromDate.getUTCDate() - 84)
  const from = fromDate.toISOString().slice(0, 10)
  const to = today.toISOString().slice(0, 10)
  const [cycle, adherence, wip, heatmap] = await Promise.all([
    getCycleTimeReport({ groupBy, from, to }),
    getEvenFlowAdherence({ from, to }),
    getWipCounts(),
    getLateTaskHeatmap(),
  ])

  const weeklyAdherence = Array.from(
    adherence.reduce((weeks, row) => {
      const current = weeks.get(row.weekStart) ?? { planned: 0, actual: 0 }
      weeks.set(row.weekStart, { planned: current.planned + row.plannedStarts, actual: current.actual + row.actualStarts })
      return weeks
    }, new Map<string, { planned: number; actual: number }>()),
    ([weekStart, totals]) => ({ weekStart, ...totals }),
  ).sort((a, b) => a.weekStart.localeCompare(b.weekStart))
  const planned = weeklyAdherence.reduce((sum, week) => sum + week.planned, 0)
  const actual = weeklyAdherence.reduce((sum, week) => sum + week.actual, 0)

  return (
    <PageLayout title="Starts reports">
      <div className="space-y-8 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Trailing 12 weeks · {from} to {to}</p>
          <div className="flex flex-wrap gap-2">
            {[["WIP CSV", "wip"], ["Even-flow CSV", "even-flow"], ["Cycle-time CSV", "cycle-time"], ["Late tasks CSV", "late-tasks"]].map(([label, kind]) => (
              <Button asChild key={kind} size="sm" variant="outline" className="rounded-none">
                <a href={`/api/reports/starts?kind=${kind}&from=${from}&to=${to}`}>{label}</a>
              </Button>
            ))}
          </div>
        </div>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Work in progress</h2>
          {wip.length ? (
            <div className="grid gap-px border bg-border sm:grid-cols-2 lg:grid-cols-4">
              {wip.map((row) => (
                <div className="bg-background p-4" key={row.communityId}>
                  <p className="text-xs text-muted-foreground">{row.communityName}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{row.underConstruction}</p>
                  <p className="text-xs tabular-nums text-muted-foreground">
                    building · {row.precon} precon · {row.readyBacklog} ready
                    {row.attention > 0 ? <span className="text-destructive"> · {row.attention} attention</span> : null}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <p className="border p-6 text-center text-sm text-muted-foreground">No active communities yet.</p>
          )}
        </section>

        <section>
          <div className="mb-3 flex items-baseline justify-between gap-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide">Even-flow adherence</h2>
            <p className="text-xs tabular-nums text-muted-foreground">{actual}/{planned} starts released against plan</p>
          </div>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide">
                  <TableHead>Week of</TableHead>
                  <TableHead className="text-right">Planned</TableHead>
                  <TableHead className="text-right">Actual</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {weeklyAdherence.length ? weeklyAdherence.map((week) => {
                  const variance = week.actual - week.planned
                  return (
                    <TableRow key={week.weekStart} className="text-xs">
                      <TableCell className="tabular-nums">{week.weekStart}</TableCell>
                      <TableCell className="text-right tabular-nums">{week.planned}</TableCell>
                      <TableCell className="text-right tabular-nums">{week.actual}</TableCell>
                      <TableCell className={cn("text-right tabular-nums", variance > 0 && "text-destructive", variance < 0 && "text-warning")}>
                        {variance > 0 ? `+${variance}` : variance}
                      </TableCell>
                    </TableRow>
                  )
                }) : (
                  <TableRow><TableCell colSpan={4} className="h-20 text-center text-muted-foreground">Release slots will appear here once communities are active.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide">Cycle time</h2>
            <div className="flex border text-xs" role="group" aria-label="Cycle-time grouping">
              {GROUPS.map(([value, label]) => (
                <Link
                  key={value}
                  href={value === "community" ? "/starts/reports" : `/starts/reports?group=${value}`}
                  className={cn(
                    "px-3 py-1.5",
                    value === groupBy ? "bg-foreground font-medium text-background" : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-current={value === groupBy ? "true" : undefined}
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide">
                  <TableHead>{groupBy === "plan" ? "Plan" : groupBy === "superintendent" ? "Superintendent" : "Community"}</TableHead>
                  <TableHead className="text-right">Homes</TableHead>
                  <TableHead className="text-right">Median days</TableHead>
                  <TableHead className="text-right">P80 days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cycle.length ? cycle.map((row) => (
                  <TableRow key={row.groupKey} className="text-xs">
                    <TableCell>{row.groupLabel}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.count}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", row.medianDays > 130 && "text-warning")}>{row.medianDays}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.p80Days}</TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={4} className="h-20 text-center text-muted-foreground">Completed production houses will appear here — cycle time runs start to close.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Start-to-completion, calendar days. Production target: 120–130 days.</p>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Late-task heatmap</h2>
          <div className="overflow-x-auto border">
            <Table>
              <TableHeader>
                <TableRow className="text-[11px] uppercase tracking-wide">
                  <TableHead>Lot</TableHead>
                  <TableHead>Phase</TableHead>
                  <TableHead className="text-right">Late tasks</TableHead>
                  <TableHead className="text-right">Worst delay</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {heatmap.length ? heatmap.map((row) => (
                  <TableRow key={`${row.projectId}:${row.phase}`} className="text-xs">
                    <TableCell className="font-medium">{row.lotLabel}</TableCell>
                    <TableCell className="text-muted-foreground">{row.phase ?? "Unphased"}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.lateCount}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", row.maxDaysLate > 7 && "text-destructive")}>{row.maxDaysLate}d</TableCell>
                  </TableRow>
                )) : (
                  <TableRow><TableCell colSpan={4} className="h-20 text-center text-muted-foreground">No late production schedule items. The line is running clean.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </div>
    </PageLayout>
  )
}
