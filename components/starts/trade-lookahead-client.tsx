"use client"

import { useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { TradeLookaheadRow } from "@/lib/services/trade-lookahead"
import { sendTradeLookaheadAction } from "@/app/(app)/starts/actions"

export function TradeLookaheadClient({ rows, weeks }: { rows: TradeLookaheadRow[]; weeks: 2 | 3 | 4 }) {
  const [pending, startTransition] = useTransition()
  return <div className="border"><Table><TableHeader><TableRow><TableHead>Trade company</TableHead><TableHead>Trade</TableHead><TableHead>Upcoming work</TableHead><TableHead>First date</TableHead><TableHead className="text-right">Dispatch</TableHead></TableRow></TableHeader><TableBody>
    {rows.length ? rows.map((row) => {
      const companyId = row.companyId
      return <TableRow key={`${companyId ?? "none"}:${row.trade ?? ""}`}><TableCell className="font-medium">{row.companyName}</TableCell><TableCell>{row.trade ?? "—"}</TableCell><TableCell className="tabular-nums">{row.items.length}</TableCell><TableCell className="tabular-nums">{row.items[0]?.startDate ?? "—"}</TableCell><TableCell className="text-right">{companyId ? <Button size="sm" variant="outline" disabled={pending} onClick={() => startTransition(async () => { unwrapAction(await sendTradeLookaheadAction(companyId, { weeks })) })}>Send</Button> : <span className="text-xs text-muted-foreground">Assign trade</span>}</TableCell></TableRow>
    }) : <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No trade work falls in this look-ahead window.</TableCell></TableRow>}
  </TableBody></Table></div>
}
