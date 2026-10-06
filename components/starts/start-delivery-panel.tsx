"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { unwrapAction } from "@/lib/action-result"
import type { StartDeliveryPageDTO } from "@/lib/services/starts-confirmation-recovery"
import { clearPendingDeliveryRecovery, readPendingDeliveryRecovery, savePendingDeliveryRecovery, type PendingDeliveryRecovery } from "@/lib/starts/delivery-recovery-request"
import { inspectStartNotificationDeliveriesAction, retryStartNotificationDeliveryAction } from "@/app/(app)/starts/actions"

export function StartDeliveryPanel({ packageId }: { packageId: string }) {
  const [page, setPage] = useState<StartDeliveryPageDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [failedOnly, setFailedOnly] = useState(true)
  const [cursors, setCursors] = useState<Array<string | null>>([null])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [previous, setPrevious] = useState<PendingDeliveryRecovery | null>(null)
  const sequence = useRef(0)
  const recoveryInFlight = useRef(false)

  async function load(nextCursors: Array<string | null>, failures: boolean) {
    const version = ++sequence.current
    setLoading(true); setError(null)
    try {
      const result = unwrapAction(await inspectStartNotificationDeliveriesAction(packageId, { after: nextCursors[nextCursors.length - 1], failedOnly: failures }))
      if (version !== sequence.current) return
      setPage(result); setCursors(nextCursors); setFailedOnly(failures); setSelectedId(null)
      try { setPrevious(readPendingDeliveryRecovery(sessionStorage, result.scope)); setStorageError(null) }
      catch { setStorageError("Unable to restore the previous retry. Resolve browser session storage before starting another recovery.") }
    } catch (failure) {
      if (version === sequence.current) setError(failure instanceof Error ? failure.message : "Unable to inspect delivery")
    } finally { if (version === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    void load([null], true)
    return () => { sequence.current++ }
    // This keyed panel is replaced whenever the selected package changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packageId])

  async function recover(request: PendingDeliveryRecovery) {
    if (!page || recoveryInFlight.current) return
    recoveryInFlight.current = true
    setSubmitting(true); setError(null)
    try {
      // Persist before the server call. An uncertain response keeps this exact
      // request and reason across closing/reopening the sheet or a page reload.
      savePendingDeliveryRecovery(sessionStorage, page.scope, request)
      setPrevious(request)
      const result = unwrapAction(await retryStartNotificationDeliveryAction(packageId, request))
      clearPendingDeliveryRecovery(sessionStorage, page.scope)
      setPrevious(null); setReason(""); setSelectedId(null)
      toast.success(result.replayed ? "Previous retry confirmed" : "Delivery retry queued", {
        description: result.status === "failed" ? "That delivery failed again. Review the current error before creating another retry." : undefined,
      })
      await load([null], failedOnly)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to recover delivery")
    } finally { recoveryInFlight.current = false; setSubmitting(false) }
  }
  const disabled = loading || submitting
  return (
    <div className="space-y-3 border-b p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Release alert delivery</h3>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void load([null], failedOnly)}>Refresh</Button>
      </div>
      <div className="flex gap-2">
        <Button variant={failedOnly ? "secondary" : "ghost"} size="sm" disabled={disabled} onClick={() => void load([null], true)}>Failed</Button>
        <Button variant={!failedOnly ? "secondary" : "ghost"} size="sm" disabled={disabled} onClick={() => void load([null], false)}>All deliveries</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {storageError ? <p role="alert" className="text-xs text-destructive">{storageError}</p> : null}
      {previous ? (
        <div className="space-y-2 border p-3">
          <p className="text-xs font-medium">Previous retry needs confirmation</p>
          <p className="text-xs text-muted-foreground">{previous.reason}</p>
          <Button size="sm" disabled={disabled || Boolean(storageError)} onClick={() => void recover(previous)}>Check previous retry</Button>
        </div>
      ) : null}
      {loading ? <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : page?.items.length ? (
        <div className="divide-y border-y">
          {page.items.map(item => (
            <div key={item.receipt_id} className="space-y-1 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate text-xs font-medium">{item.recipient_name} · {item.channel === "deliver_push" ? "Push" : "Email"}</p>
                <span className={item.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{item.status}</span>
              </div>
              {item.error ? <p className="break-words text-xs text-muted-foreground">{item.error}</p> : null}
              {item.status === "failed" && !item.error ? <p className="text-xs text-muted-foreground">No failure details are retained. Review delivery before retrying.</p> : null}
              {!item.source_available ? <p className="text-xs text-warning">Original alert unavailable. Reconciliation is required.</p> : null}
              {item.status === "failed" && item.source_available ? (
                <Button variant="outline" size="sm" disabled={disabled || Boolean(previous) || Boolean(storageError) || Boolean(error)} onClick={() => { setSelectedId(item.receipt_id); setReason("") }}>Recover delivery</Button>
              ) : null}
              {selectedId === item.receipt_id && !previous ? (
                <div className="space-y-2 pt-2">
                  <Label htmlFor="delivery-recovery-reason">Recovery reason</Label>
                  <Textarea id="delivery-recovery-reason" value={reason} maxLength={1000} disabled={disabled} onChange={event => setReason(event.target.value)} placeholder="Describe what was repaired (at least 10 characters)" />
                  <Button size="sm" disabled={disabled || reason.trim().length < 10} onClick={() => void recover({ receiptId: item.receipt_id, requestId: crypto.randomUUID(), reason: reason.trim() })}>Queue retry</Button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : page ? <p className="text-xs text-muted-foreground">{failedOnly ? "No failed deliveries on this page." : "No recorded alert deliveries."}</p> : null}
      {page && !loading ? (
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" disabled={disabled || cursors.length === 1} onClick={() => void load(cursors.slice(0, -1), failedOnly)}>Previous</Button>
          <span className="text-xs tabular-nums text-muted-foreground">Page {cursors.length} · {page.items.length} deliveries</span>
          <Button variant="ghost" size="sm" disabled={disabled || !page.has_more} onClick={() => void load([...cursors, page.next_cursor], failedOnly)}>Next</Button>
        </div>
      ) : null}
    </div>
  )
}
