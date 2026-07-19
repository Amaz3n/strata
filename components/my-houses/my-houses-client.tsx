"use client"

import Link from "next/link"
import { useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { MyHouseDTO, MyHouseTaskGroupDTO } from "@/lib/services/my-houses"
import { completeScheduleItemAction } from "@/app/(app)/my-houses/actions"

export function MyHousesClient({ houses, work }: { houses: MyHouseDTO[]; work: MyHouseTaskGroupDTO[] }) {
  const [pending, startTransition] = useTransition()
  if (!houses.length) return <div className="border p-8 text-center text-sm text-muted-foreground">No houses assigned.</div>
  return <div className="space-y-8">
    <section className="space-y-3"><h2 className="text-xs font-semibold uppercase tracking-wide">This week across houses</h2>{work.length ? work.map((group) => <div className="border" key={group.groupKey}><div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold">{group.groupLabel} — {group.items.length} houses</div><Table><TableBody>{group.items.map((item) => <TableRow key={item.scheduleItemId}><TableCell className="font-medium">{item.lotLabel}</TableCell><TableCell>{item.communityName}</TableCell><TableCell className="tabular-nums">{item.startDate ?? "—"} – {item.endDate ?? "—"}</TableCell><TableCell>{item.trade ?? "—"}</TableCell><TableCell className={item.daysLate ? "text-warning" : "text-muted-foreground"}>{item.daysLate ? `${item.daysLate}d late` : item.status}</TableCell><TableCell className="text-right"><Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => { unwrapAction(await completeScheduleItemAction(item.scheduleItemId)) })}>Complete</Button></TableCell></TableRow>)}</TableBody></Table></div>) : <div className="border p-6 text-sm text-muted-foreground">No scheduled work in this window.</div>}</section>
    <section><h2 className="mb-3 text-xs font-semibold uppercase tracking-wide">Assigned houses</h2><div className="border"><Table><TableHeader><TableRow><TableHead>Lot</TableHead><TableHead>Community</TableHead><TableHead>Plan</TableHead><TableHead>Phase</TableHead><TableHead>Days</TableHead><TableHead>Complete</TableHead><TableHead>Late</TableHead><TableHead>Punch</TableHead><TableHead>Last log</TableHead></TableRow></TableHeader><TableBody>{houses.map((house) => <TableRow key={house.projectId}><TableCell><Link className="font-medium underline-offset-4 hover:underline" href={`/projects/${house.projectId}`}>{house.lotLabel}</Link></TableCell><TableCell>{house.communityName}</TableCell><TableCell>{house.planCode ?? "—"}</TableCell><TableCell>{house.currentPhase ?? "—"}</TableCell><TableCell className="tabular-nums">{house.daysInProgress}{house.targetDays ? ` / ${house.targetDays}` : ""}</TableCell><TableCell className="tabular-nums">{house.percentComplete}%</TableCell><TableCell className={house.lateCount ? "text-warning tabular-nums" : "tabular-nums"}>{house.lateCount}</TableCell><TableCell className="tabular-nums">{house.openPunch}</TableCell><TableCell className="tabular-nums">{house.lastDailyLogDate ?? "—"}</TableCell></TableRow>)}</TableBody></Table></div></section>
  </div>
}
