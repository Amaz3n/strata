"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { closePoLineShortAction, getPoReceivingAction, setLineNeededByAction, voidPoReceiptAction } from "@/app/(app)/purchasing/delivery-actions"
import { DELIVERY_STATE_LABELS, DELIVERY_STATE_TONE, formatDay, formatQuantity } from "@/components/purchasing/delivery-format"
import { ReceiveDeliveryDialog } from "@/components/purchasing/receive-delivery-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { DeliveryLine, PoReceiving } from "@/lib/services/po-receipts"

const CONDITION_LABELS = { ok: "Good", damaged: "Damaged", wrong_item: "Wrong item" } as const

/**
 * The order's own view of its deliveries: what each tracked line has received
 * and still owes, the lines with no need-by date yet, and the tickets. Loaded
 * when the sheet opens; every change calls the po-receipts service.
 */
export function ReceivingSection({ commitmentId }: { commitmentId: string }) {
  const [data, setData] = useState<PoReceiving | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [receiving, setReceiving] = useState<string | true | null>(null)
  const [voiding, setVoiding] = useState<{ id: string; reason: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const load = useCallback(async () => {
    setError(null)
    try {
      const result = await getPoReceivingAction(commitmentId)
      if (result.success) setData(result.data)
      else setError(result.error)
    } catch {
      setError("Unable to load deliveries.")
    }
  }, [commitmentId])

  useEffect(() => {
    setData(null)
    void load()
  }, [load])

  const mutate = (work: () => Promise<{ success: boolean; error?: string }>, done: string) => startTransition(async () => {
    try {
      const result = await work()
      if (result.success) { toast.success(done); await load() }
      else toast.error(result.error ?? "Action failed")
    } catch {
      toast.error("Unable to confirm the result. Refresh before retrying.")
    }
  })

  if (error) return <div className="space-y-2">
    <SectionTitle />
    <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      <p>Could not load deliveries. {error}</p>
      <Button variant="outline" size="sm" className="mt-2 h-7 text-xs" onClick={() => void load()}>Retry</Button>
    </div>
  </div>
  if (!data) return <div className="space-y-2" aria-busy role="status" aria-label="Loading deliveries"><SectionTitle /><Skeleton className="h-20 w-full" /></div>

  const issued = data.orderStatus === "approved"
  const owed = data.tracked.some((line) => line.outstanding > 0)
  const setDate = (line: { id: string }, value: string) => mutate(
    () => setLineNeededByAction({ commitmentLineId: line.id, neededBy: value || null }, data.projectId), value ? "Need-by date saved" : "Need-by date cleared")

  return <div className="space-y-2" aria-busy={pending}>
    <div className="flex items-center justify-between gap-2">
      <SectionTitle count={data.tracked.length} />
      {data.canRecord && issued && owed && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setReceiving(true)}>Receive delivery</Button>}
    </div>
    {data.tracked.length > 0 && <div className="border">
      <table className="w-full text-sm">
        <thead><tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
          <th className="px-3 py-1.5">Line</th><th className="px-3 py-1.5 text-right">Ordered</th><th className="px-3 py-1.5 text-right">Received</th>
          <th className="px-3 py-1.5 text-right">Outstanding</th><th className="px-3 py-1.5">Expected</th><th className="px-3 py-1.5">State</th><th />
        </tr></thead>
        <tbody>{data.tracked.map((line) => <TrackedRow key={line.lineId} line={line} data={data} pending={pending} issued={issued}
          onDate={(value) => setDate({ id: line.lineId }, value)}
          onReceive={() => setReceiving(line.lineId)}
          onCloseShort={() => mutate(() => closePoLineShortAction({ commitmentLineId: line.lineId, reason: line.received > 0 ? "vendor_short" : "not_delivered" }, data.projectId), "Line closed short; purchasing was told")} />)}</tbody>
      </table>
    </div>}
    {data.tracked.length === 0 && data.untracked.length === 0 && <p className="border px-3 py-3 text-sm text-muted-foreground">No lines.</p>}
    {data.untracked.length > 0 && <div className="border">
      <p className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">Not tracked: add a need-by date to receive a line</p>
      {data.untracked.map((line) => <div key={line.id} className="flex items-center justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0">
        <span className="min-w-0 truncate">{line.description} <span className="text-xs text-muted-foreground">{formatQuantity(line.quantity)} {line.unit}</span></span>
        {data.canSetDates && (data.orderStatus === "draft" || issued)
          ? <Input type="date" aria-label={`Need-by date: ${line.description}`} defaultValue="" disabled={pending} onBlur={(event) => { if (event.target.value) setDate(line, event.target.value) }} className="h-8 w-40" />
          : null}
      </div>)}
    </div>}
    {data.receipts.length > 0 && <div className="border">
      <p className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">Tickets</p>
      {data.receipts.map((receipt) => <div key={receipt.id} className={cn("border-b px-3 py-2 text-sm last:border-b-0", receipt.status === "void" && "text-muted-foreground")}>
        <div className="flex items-baseline justify-between gap-3">
          <span className={cn("font-medium", receipt.status === "void" && "line-through")}>{formatDay(receipt.receivedAt.slice(0, 10))}{receipt.ticketNumber ? ` · Ticket ${receipt.ticketNumber}` : ""}</span>
          {receipt.status === "recorded" && data.canResolve && voiding?.id !== receipt.id
            ? <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={pending} onClick={() => setVoiding({ id: receipt.id, reason: "" })}>Void</Button>
            : receipt.status === "void" ? <span className="text-xs">Void: {receipt.voidReason}</span> : null}
        </div>
        {voiding?.id === receipt.id && <div className="mt-2 flex items-center gap-2">
          <Input aria-label="Why is this receipt void?" placeholder="Why is this receipt void?" value={voiding.reason} maxLength={2000} disabled={pending} onChange={(event) => setVoiding({ id: receipt.id, reason: event.target.value })} className="h-8 text-xs" />
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pending || voiding.reason.trim().length < 3}
            onClick={() => { mutate(() => voidPoReceiptAction({ receiptId: receipt.id, reason: voiding.reason }, data.projectId), "Receipt voided"); setVoiding(null) }}>Void receipt</Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={pending} onClick={() => setVoiding(null)}>Cancel</Button>
        </div>}
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">{receipt.lines.map((line) => <li key={line.commitmentLineId}>
          {formatQuantity(line.quantity)} {line.unit} {line.description}
          {line.condition !== "ok" ? ` · ${CONDITION_LABELS[line.condition]}` : ""}{line.overReceiptReason ? ` · Over: ${line.overReceiptReason}` : ""}
        </li>)}</ul>
        {receipt.note && <p className="mt-1 text-xs text-muted-foreground">{receipt.note}</p>}
      </div>)}
    </div>}
    {receiving !== null && <ReceiveDeliveryDialog projectId={data.projectId} commitmentId={commitmentId} lineId={typeof receiving === "string" ? receiving : undefined}
      open onOpenChange={(open) => { if (!open) setReceiving(null) }} onDone={() => void load()} />}
  </div>
}

function SectionTitle({ count }: { count?: number }) {
  return <div className="flex items-baseline gap-2"><div className="microlabel">Receiving</div>
    {typeof count === "number" ? <span className="font-mono text-xs tabular-nums text-muted-foreground">{count}</span> : null}</div>
}

function TrackedRow({ line, data, pending, issued, onDate, onReceive, onCloseShort }: {
  line: DeliveryLine
  data: PoReceiving
  pending: boolean
  issued: boolean
  onDate: (value: string) => void
  onReceive: () => void
  onCloseShort: () => void
}) {
  const open = line.outstanding > 0 && issued
  return <tr className="border-b align-top last:border-b-0">
    <td className="px-3 py-2">{line.description}{line.shortageReasonLabel && line.shortageReason !== "late" ? <span className="block text-xs text-muted-foreground">{line.shortageReasonLabel}</span> : null}</td>
    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{formatQuantity(line.ordered)}</td>
    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{formatQuantity(line.received)}</td>
    <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">{formatQuantity(line.outstanding)} {line.unit}</td>
    <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums">
      {data.canSetDates && line.received === 0 && issued
        ? <Input type="date" aria-label={`Need-by date: ${line.description}`} defaultValue={line.neededBy} disabled={pending} onBlur={(event) => { if (event.target.value !== line.neededBy) onDate(event.target.value) }} className="h-7 w-36 text-xs" />
        : formatDay(line.expectedDate)}
    </td>
    <td className="px-3 py-2"><span className={cn("text-xs font-medium", DELIVERY_STATE_TONE[line.state])}>{DELIVERY_STATE_LABELS[line.state]}</span>
      {line.daysLate > 0 && line.outstanding > 0 ? <span className="block text-xs tabular-nums text-destructive">{line.daysLate}d late</span> : null}</td>
    <td className="whitespace-nowrap px-3 py-2 text-right">
      {data.canRecord && open && <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={pending} onClick={onReceive}>Receive</Button>}
      {data.canRecord && open && !line.shortageId && <Button size="sm" variant="ghost" className="h-6 text-xs" disabled={pending} onClick={onCloseShort}>Close short</Button>}
    </td>
  </tr>
}
