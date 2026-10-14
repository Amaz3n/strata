"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTransition } from "react"
import { toast } from "sonner"
import { Send } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { TradeLookaheadSummary, TradeLookaheadRow } from "@/lib/services/trade-lookahead"
import { sendTradeLookaheadAction } from "@/app/(app)/schedule/trade-actions"
import { setScheduleAssigneeAction } from "@/app/(app)/schedule/assignment-actions"

interface Props {
  rows: TradeLookaheadSummary[]
  selected: (TradeLookaheadSummary & { items: TradeLookaheadRow["items"] }) | null
  total: number
  weeks: 2 | 3 | 4
  canSend: boolean
  canAssign: boolean
  scope: { communityId?: string; divisionId?: string }
  listHref: string
}
export function TradeLookaheadClient({ rows, selected, total, weeks, canSend, canAssign, scope, listHref }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const send = (companyId: string, companyName: string) => {
    if (!canSend || pending) return
    startTransition(async () => {
      try {
        const result = unwrapAction(await sendTradeLookaheadAction(companyId, { weeks, ...scope }))
        if (result.sent) toast.success(`Look-ahead sent to ${companyName}`)
        else toast.info(`A look-ahead was already recorded for ${companyName} today`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to send look-ahead", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }
  const assign = (item: TradeLookaheadRow["items"][number], companyId: string, companyName: string) => {
    if (pending) return
    startTransition(async () => {
      try {
        await setScheduleAssigneeAction({ scheduleItemId: item.scheduleItemId, projectId: item.projectId, assignee: { type: "company", id: companyId } })
        toast.success(`${item.name} assigned to ${companyName}`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to assign this task", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }
  const groupHref = (key: string) => {
    const [path, query] = listHref.split("?")
    const params = new URLSearchParams(query)
    params.set("group", key)
    return `${path}?${params}`
  }
  return <div className="space-y-3">
    {!rows.length && <div className="border px-6 py-12 text-center">
      <p className="text-sm font-medium">{total ? "No groups on this page" : "No trade work matches this view"}</p>
      <Link href={listHref.replace(/([?&])page=\d+/, "$1page=1")} className="text-sm underline">Return to first page</Link>
    </div>}
    {!!rows.length && <div className="overflow-x-auto border"><Table>
      <TableHeader><TableRow><TableHead>Trade company</TableHead><TableHead>Trade</TableHead><TableHead className="text-right">Tasks</TableHead><TableHead className="text-right">Confirmed</TableHead><TableHead>First date</TableHead><TableHead>Dispatch</TableHead></TableRow></TableHeader>
      <TableBody>{rows.map(row => <TableRow key={row.key} className="text-xs">
        <TableCell className="font-medium"><Link href={groupHref(row.key)} className="underline underline-offset-4" aria-label={`View tasks for ${row.companyName}, ${row.trade ?? "unclassified trade"}`}>{row.companyName}</Link></TableCell>
        <TableCell>{row.trade ?? "—"}</TableCell><TableCell className="text-right tabular-nums">{row.itemCount}{row.inferredCount ? <span className="ml-1 text-muted-foreground">({row.inferredCount} inferred)</span> : null}</TableCell><TableCell className="text-right tabular-nums">{row.confirmedCount}/{row.itemCount}</TableCell><TableCell>{row.firstDate ?? "—"}</TableCell>
        <TableCell>{row.companyId && canSend ? <Button size="sm" variant="outline" disabled={pending} aria-label={`Send company schedule to ${row.companyName}`} onClick={() => { if (row.companyId) send(row.companyId, row.companyName) }}><Send className="mr-1.5 h-3.5 w-3.5" />{pending ? "Sending…" : "Send"}</Button> : <span className="text-muted-foreground">{row.companyId ? "Read only" : "Assign trade on home schedule"}</span>}</TableCell>
      </TableRow>)}</TableBody>
    </Table></div>}
    {canSend && rows.some(row => row.companyId) && <p className="text-xs text-muted-foreground">Send includes the assigned work for that company in the reviewed community, division and date window. Work inferred from a purchase order is left out until it is assigned.</p>}
    {selected && <section className="border" aria-label="Selected trade tasks">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-3"><h2 className="text-sm font-medium">{selected.companyName} · {selected.trade ?? "Unclassified"} · {selected.itemCount} tasks</h2><Link href={listHref} className="text-sm underline">Close tasks</Link></div>
      <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Home</TableHead><TableHead>Task</TableHead><TableHead>Dates</TableHead><TableHead>Assignment</TableHead><TableHead>Confirmation</TableHead></TableRow></TableHeader><TableBody>{selected.items.map(item => <TableRow key={item.scheduleItemId} className="text-xs"><TableCell>{item.communityName} · {item.lotLabel}</TableCell><TableCell><Link className="underline underline-offset-4" href={`/projects/${encodeURIComponent(item.projectId)}/schedule?item=${encodeURIComponent(item.scheduleItemId)}`}>{item.name}</Link></TableCell><TableCell>{item.startDate} → {item.endDate}</TableCell><TableCell>{item.assignment === "inferred" ? <span className="inline-flex items-center gap-1.5"><Badge variant="outline" className="text-warning">Inferred from PO</Badge>{canAssign && selected.companyId ? <Button size="sm" variant="outline" disabled={pending} onClick={() => { if (selected.companyId) assign(item, selected.companyId, selected.companyName) }}>Assign</Button> : null}</span> : <span className="text-muted-foreground">{item.assignment === "assigned" ? "Assigned" : "Unassigned"}</span>}</TableCell><TableCell><Badge variant="outline">{item.confirmation}</Badge></TableCell></TableRow>)}</TableBody></Table></div>
      {!selected.items.length && <p className="p-3 text-sm text-muted-foreground">No tasks on this page. Use the task pagination to return to an available page.</p>}
    </section>}
  </div>
}
