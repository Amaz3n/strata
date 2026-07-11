"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, CalendarDays } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { DailyReport, ScheduleItem } from "@/lib/types"

export function DelayLogView({ reports, scheduleItems }: { reports: DailyReport[]; scheduleItems: ScheduleItem[] }) {
  const [filter, setFilter] = useState("claims")
  const [search, setSearch] = useState("")
  const scheduleById = useMemo(() => new Map(scheduleItems.map((item) => [item.id, item])), [scheduleItems])
  const delays = useMemo(() => reports.flatMap((report) => (report.delays ?? []).map((delay) => ({ ...delay, reportDate: report.date }))).filter((delay) => filter === "all" || delay.potential_claim).filter((delay) => !search || `${delay.description} ${delay.affected_trades ?? ""}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.reportDate.localeCompare(a.reportDate)), [filter, reports, search])

  return <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
    <div className="flex h-14 items-center justify-between border-b px-6"><div><h2 className="text-sm font-semibold">Delay log</h2><p className="text-xs text-muted-foreground">Claims evidence across daily reports</p></div><div className="flex items-center gap-2"><Input className="h-8 w-56" placeholder="Search delays" value={search} onChange={(event) => setSearch(event.target.value)} /><Select value={filter} onValueChange={setFilter}><SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="claims">Potential claims</SelectItem><SelectItem value="all">All delays</SelectItem></SelectContent></Select></div></div>
    <div className="min-h-0 flex-1 overflow-auto">
      {delays.length === 0 ? <div className="grid min-h-64 place-items-center text-center"><div><AlertTriangle className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-2 text-sm font-medium">No matching delays</p><p className="text-xs text-muted-foreground">Logged delays appear here with their schedule linkage.</p></div></div> : <table className="w-full text-sm"><thead className="sticky top-0 bg-background text-left text-[10px] uppercase tracking-wider text-muted-foreground"><tr className="border-b"><th className="px-6 py-2 font-medium">Date</th><th className="px-3 py-2 font-medium">Type</th><th className="px-3 py-2 font-medium">Description</th><th className="px-3 py-2 font-medium">Schedule item</th><th className="px-3 py-2 text-right font-medium">Hours</th><th className="px-6 py-2 font-medium">Claim</th></tr></thead><tbody>{delays.map((delay) => <tr key={delay.id} className="border-b border-border/60"><td className="whitespace-nowrap px-6 py-3 font-mono text-xs tabular-nums"><span className="inline-flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />{delay.reportDate}</span></td><td className="px-3 py-3 capitalize">{delay.delay_type}</td><td className="max-w-md px-3 py-3"><p className="font-medium">{delay.description}</p>{delay.affected_trades && <p className="mt-0.5 text-xs text-muted-foreground">{delay.affected_trades}</p>}</td><td className="px-3 py-3 text-muted-foreground">{delay.schedule_item_id ? scheduleById.get(delay.schedule_item_id)?.name ?? "Removed item" : "—"}</td><td className="px-3 py-3 text-right font-mono text-xs tabular-nums">{delay.hours_lost ?? "—"}</td><td className="px-6 py-3">{delay.potential_claim ? <Badge variant="outline">Potential claim</Badge> : "—"}</td></tr>)}</tbody></table>}
    </div>
  </div>
}
