"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { toast } from "sonner"

import { listHomeOpenDeliveriesAction, recordPoReceiptAction } from "@/app/(app)/purchasing/delivery-actions"
import { formatDay, formatQuantity } from "@/components/purchasing/delivery-format"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import { uploadDocumentForm } from "@/lib/files/upload-document-form"
import type { DeliveryLine } from "@/lib/services/po-receipts"

type Condition = "ok" | "damaged" | "wrong_item"
type Entry = { quantity: string; condition: Condition; note: string; overReason: string }

const asCondition = (value: string): Condition => value === "damaged" || value === "wrong_item" ? value : "ok"

const emptyEntry: Entry = { quantity: "", condition: "ok", note: "", overReason: "" }

const MAX_PHOTOS = 20

const selectClass = "h-8 border bg-background px-2 text-sm"

/**
 * Receive a delivery against one of a home's issued purchase orders: a quantity
 * per line, a condition, a ticket. The dialog opens from the order's sheet, the
 * Deliveries desk, the daily report and the schedule, so one capture path feeds
 * one ledger. The key is made when the dialog opens: a retry of the same ticket
 * is the same delivery, a new ticket is a new key.
 */
export function ReceiveDeliveryDialog({ projectId, commitmentId, lineId, open, onOpenChange, onDone }: {
  projectId: string
  commitmentId?: string
  lineId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone?: () => void
}) {
  const [lines, setLines] = useState<DeliveryLine[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [orderId, setOrderId] = useState<string | undefined>(commitmentId)
  const [entries, setEntries] = useState<Record<string, Entry>>({})
  const [ticket, setTicket] = useState("")
  const [note, setNote] = useState("")
  const [photos, setPhotos] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const key = useRef("")

  useEffect(() => {
    if (!open) return
    key.current = crypto.randomUUID()
    setLines(null)
    setLoadError(null)
    setError(null)
    setEntries({})
    setTicket("")
    setNote("")
    setPhotos([])
    setOrderId(commitmentId)
    let cancelled = false
    void listHomeOpenDeliveriesAction(projectId).then((result) => {
      if (cancelled) return
      if (!result.success) { setLoadError(result.error); return }
      if (!result.data) { setLoadError("You do not have access to this home's deliveries."); return }
      setLines(result.data.lines)
      setTruncated(result.data.truncated)
      setOrderId((current) => current ?? result.data?.lines.find((line) => line.lineId === lineId)?.commitmentId ?? result.data?.lines[0]?.commitmentId)
    }).catch(() => { if (!cancelled) setLoadError("Unable to load this home's deliveries. Close and try again.") })
    return () => { cancelled = true }
  }, [open, projectId, commitmentId, lineId])

  const orders = useMemo(() => {
    const byId = new Map<string, { id: string; title: string; vendor: string | null }>()
    for (const line of lines ?? []) if (!byId.has(line.commitmentId)) byId.set(line.commitmentId, { id: line.commitmentId, title: line.poTitle, vendor: line.vendorName })
    return Array.from(byId.values())
  }, [lines])
  const orderLines = (lines ?? []).filter((line) => line.commitmentId === orderId)
  const entryFor = (id: string) => entries[id] ?? emptyEntry
  const setEntry = (id: string, patch: Partial<Entry>) => setEntries((current) => ({ ...current, [id]: { ...(current[id] ?? emptyEntry), ...patch } }))

  const filled = orderLines.filter((line) => Number(entryFor(line.lineId).quantity) > 0)
  const overLines = filled.filter((line) => entryFor(line.lineId).condition === "ok" && Number(entryFor(line.lineId).quantity) > line.outstanding)
  const missingReason = overLines.some((line) => entryFor(line.lineId).overReason.trim().length < 3)
  const valid = filled.length > 0 && !missingReason

  function submit() {
    if (!orderId || !valid) return
    setError(null)
    startTransition(async () => {
      try {
        // Photos are home files first; the database checks each belongs to this home.
        const photoFileIds: string[] = []
        for (const photo of photos) {
          const upload = new FormData()
          upload.set("file", photo)
          upload.set("projectId", projectId)
          upload.set("category", "photos")
          upload.set("visibility", "private")
          upload.set("description", "Delivery photo")
          photoFileIds.push(unwrapAction(await uploadDocumentForm(upload)).id)
        }
        const result = await recordPoReceiptAction({
          commitmentId: orderId,
          idempotencyKey: key.current,
          ticketNumber: ticket.trim() || undefined,
          note: note.trim() || undefined,
          photoFileIds,
          lines: filled.map((line) => {
            const entry = entryFor(line.lineId)
            return {
              commitmentLineId: line.lineId, quantity: Number(entry.quantity), condition: entry.condition,
              note: entry.note.trim() || undefined,
              overReceiptReason: entry.condition === "ok" && Number(entry.quantity) > line.outstanding ? entry.overReason.trim() : undefined,
            }
          }),
        }, projectId)
        if (!result.success) { setError(result.error); return }
        toast.success(result.data.shortageIds.length > 0 ? "Delivery recorded; the problem lines were sent to purchasing" : "Delivery recorded")
        onOpenChange(false)
        onDone?.()
      } catch {
        setError("Unable to confirm the result. Reopen this dialog; sending the same ticket again will not record it twice.")
      }
    })
  }

  return <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next) }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Receive a delivery</DialogTitle>
        <DialogDescription>Enter what arrived against each line. Damaged or wrong items are recorded but do not count as received.</DialogDescription>
      </DialogHeader>
      {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      {!loadError && lines === null && <div className="space-y-2" aria-busy role="status" aria-label="Loading lines"><Skeleton className="h-8 w-64" /><Skeleton className="h-24 w-full" /></div>}
      {lines !== null && lines.length === 0 && <p className="border px-3 py-6 text-center text-sm text-muted-foreground">Nothing is waiting on this home. Give a purchase-order line a need-by date to track its delivery.</p>}
      {lines !== null && lines.length > 0 && <>
        {orders.length > 1 && <div className="grid gap-1.5 text-xs">
          <Label htmlFor="receive-order">Purchase order</Label>
          <select id="receive-order" value={orderId ?? ""} disabled={pending} onChange={(event) => setOrderId(event.target.value)} className={`${selectClass} h-9 text-sm`}>
            {orders.map((order) => <option key={order.id} value={order.id}>{order.title}{order.vendor ? ` · ${order.vendor}` : ""}</option>)}
          </select>
        </div>}
        {orders.length === 1 && <p className="text-sm font-medium">{orders[0].title}{orders[0].vendor ? <span className="font-normal text-muted-foreground"> · {orders[0].vendor}</span> : null}</p>}
        <div className="border">
          <table className="w-full text-sm">
            <thead><tr className="border-b bg-muted/40 text-left text-xs font-medium text-muted-foreground">
              <th className="px-3 py-1.5">Line</th><th className="px-3 py-1.5 text-right">Outstanding</th><th className="w-28 px-3 py-1.5">Received</th><th className="w-36 px-3 py-1.5">Condition</th>
            </tr></thead>
            <tbody>{orderLines.map((line) => {
              const entry = entryFor(line.lineId)
              const over = entry.condition === "ok" && Number(entry.quantity) > line.outstanding
              return <tr key={line.lineId} className="border-b align-top last:border-b-0">
                <td className="px-3 py-2"><span className="block">{line.description}</span><span className="text-xs text-muted-foreground">Needed {formatDay(line.neededBy)}{line.daysLate > 0 ? ` · ${line.daysLate} days late` : ""}</span>
                  {over && <Input aria-label={`Why more than ordered: ${line.description}`} placeholder="Why more than ordered?" value={entry.overReason} maxLength={2000} disabled={pending} onChange={(event) => setEntry(line.lineId, { overReason: event.target.value })} className="mt-2 h-8 text-xs" />}
                  {entry.condition !== "ok" && <Input aria-label={`What is wrong: ${line.description}`} placeholder="What is wrong?" value={entry.note} maxLength={2000} disabled={pending} onChange={(event) => setEntry(line.lineId, { note: event.target.value })} className="mt-2 h-8 text-xs" />}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-mono tabular-nums">{formatQuantity(line.outstanding)} {line.unit}</td>
                <td className="px-3 py-2"><Input aria-label={`Quantity received: ${line.description}`} type="number" inputMode="decimal" min="0" step="any" value={entry.quantity} disabled={pending} onChange={(event) => setEntry(line.lineId, { quantity: event.target.value })} className="h-8 text-right tabular-nums" /></td>
                <td className="px-3 py-2"><select aria-label={`Condition: ${line.description}`} value={entry.condition} disabled={pending} onChange={(event) => setEntry(line.lineId, { condition: asCondition(event.target.value) })} className={selectClass}>
                  <option value="ok">Good</option><option value="damaged">Damaged</option><option value="wrong_item">Wrong item</option>
                </select></td>
              </tr>
            })}</tbody>
          </table>
        </div>
        {truncated && <p className="text-xs text-muted-foreground">This home has more open lines than fit here; the soonest {lines.length} are shown.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5 text-xs"><Label htmlFor="receive-ticket">Ticket number</Label><Input id="receive-ticket" value={ticket} maxLength={120} disabled={pending} onChange={(event) => setTicket(event.target.value)} /></div>
          <div className="grid gap-1.5 text-xs"><Label htmlFor="receive-note">Note</Label><Input id="receive-note" value={note} maxLength={2000} disabled={pending} onChange={(event) => setNote(event.target.value)} /></div>
        </div>
        <div className="grid gap-1.5 text-xs">
          <Label htmlFor="receive-photos">Photos (optional)</Label>
          <Input id="receive-photos" type="file" accept="image/*" multiple disabled={pending}
            onChange={(event) => setPhotos(Array.from(event.target.files ?? []).slice(0, MAX_PHOTOS))} />
          {photos.length > 0 && <p className="text-muted-foreground">{photos.length} photo{photos.length === 1 ? "" : "s"} will be attached to this ticket.</p>}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={pending || !valid} onClick={submit}>{pending ? "Recording…" : "Record delivery"}</Button>
        </div>
      </>}
    </DialogContent>
  </Dialog>
}
