"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import type { TradeNoticeAttention as AttentionRow } from "@/lib/validation/trade-notices"
import { resolveTradeNoticeAction } from "@/app/(app)/starts/actions"

const KIND_LABELS: Record<string, string> = {
  release: "Release notice", start_release_trade_notice: "Release notice",
  schedule_change: "Schedule change", trade_schedule_change_notice: "Schedule change",
  lookahead: "Look-ahead", start_package_notice: "Package alert",
}

interface Props {
  rows: AttentionRow[]
  total: number
  limit: number
  canResolve: boolean
}

/** Failed and unresolved trade notices in scope. Retrying a failed job happens on the house's package sheet; the desk links there. */
export function TradeNoticeAttention({ rows, total, limit, canResolve }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [target, setTarget] = useState<{ deliveryId: string; resolution: "delivered" | "resend" } | null>(null)
  const [note, setNote] = useState("")

  if (!rows.length) return <p className="border px-3 py-2 text-xs text-muted-foreground">No trade notices need attention.</p>

  const resolve = () => {
    if (!target) return
    startTransition(async () => {
      try {
        unwrapAction(await resolveTradeNoticeAction({ ...target, note: note.trim() }))
        toast.success(target.resolution === "delivered" ? "Notice marked delivered" : "Notice queued to send again")
        setTarget(null)
        router.refresh()
      } catch (error) {
        toast.error("Unable to resolve trade notice", { description: error instanceof Error ? error.message : undefined })
      }
    })
  }

  return <section className="border" aria-label="Trade notices needing attention">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
      <h2 className="text-sm font-medium">Notices needing attention</h2>
      <span className="text-xs tabular-nums text-muted-foreground">{total > rows.length ? `Showing ${limit} of ${total}` : `${total} total`}</span>
    </div>
    <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow><TableHead>Trade company</TableHead><TableHead>Notice</TableHead><TableHead>Home</TableHead><TableHead>State</TableHead><TableHead>Detail</TableHead><TableHead /></TableRow></TableHeader>
      <TableBody>{rows.map((row) => <TableRow key={`${row.source}:${row.id}`} className="text-xs">
        <TableCell className="font-medium">{row.company_name ?? "Start package"}</TableCell>
        <TableCell>{KIND_LABELS[row.kind] ?? row.kind}</TableCell>
        <TableCell>{row.project_name ?? "—"}</TableCell>
        <TableCell><Badge variant="outline" className={cn(row.status === "ambiguous" ? "text-warning" : "text-destructive")}>{row.status === "ambiguous" ? "Outcome unknown" : "Failed"}</Badge></TableCell>
        <TableCell className="max-w-sm truncate text-muted-foreground" title={row.last_error ?? undefined}>{row.last_error ?? "—"}</TableCell>
        <TableCell className="text-right">
          {canResolve && row.source === "delivery" && row.status === "ambiguous" ? <span className="inline-flex gap-1.5">
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { setNote(""); setTarget({ deliveryId: row.id, resolution: "delivered" }) }}>Mark delivered</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => { setNote(""); setTarget({ deliveryId: row.id, resolution: "resend" }) }}>Send again</Button>
          </span> : row.package_id ? <Link className="underline underline-offset-4" href={`/starts?package=${encodeURIComponent(row.package_id)}`}>Open house</Link> : null}
        </TableCell>
      </TableRow>)}</TableBody>
    </Table></div>
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) setTarget(null) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{target?.resolution === "delivered" ? "Mark notice delivered" : "Send notice again"}</DialogTitle>
          <DialogDescription>
            {target?.resolution === "delivered"
              ? "Record that the trade did receive this notice."
              : "The same words go to the same people under a new delivery. If the first one did arrive, the trade gets it twice."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="trade-notice-resolve-note">Why</Label>
          <Textarea id="trade-notice-resolve-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          <p className={cn("text-xs", note.trim().length < 5 ? "text-muted-foreground" : "text-transparent")}>Minimum 5 characters.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
          <Button disabled={pending || note.trim().length < 5} onClick={resolve}>{pending ? "Saving…" : "Confirm"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
