"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { chooseSelectionAlternateAction, closeSelectionExceptionAction } from "@/app/(app)/selections/actions"
import type { HomeSelectionException } from "@/lib/services/selections"
import {
  formatSupplyDate,
  SELECTION_EXCEPTION_REASON_LABELS,
  SELECTION_EXCEPTION_STATUS_LABELS,
} from "@/lib/selections/supply-eligibility"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })

type Closing = { exception: HomeSelectionException; resolution: "waived" | "resolved_manual" | "void" }

const CLOSING_COPY: Record<Closing["resolution"], { title: string; description: string; action: string }> = {
  waived: {
    title: "Approve an expedite",
    description: "The vendor has confirmed the option can still arrive in time. The buyer may then choose it directly; the reason is audited.",
    action: "Approve expedite",
  },
  resolved_manual: {
    title: "Variance order raised by hand",
    description: "Record which purchase order now carries this cost change. The reason is audited.",
    action: "Mark handled",
  },
  void: {
    title: "Dismiss this exception",
    description: "Use this only when the exception no longer applies. The reason is audited.",
    action: "Dismiss",
  },
}

function exceptionDetail(exception: HomeSelectionException) {
  const detail = exception.detail
  if (exception.reason === "lead_time_exceeded" && typeof detail.order_by === "string") return `Order by ${formatSupplyDate(detail.order_by)}`
  if (exception.reason === "variance_unrouted" && typeof detail.cost_delta_cents === "number") {
    return `${money.format(detail.cost_delta_cents / 100)} cost change · ${typeof detail.description === "string" ? detail.description : "no purchase order"}`
  }
  if (exception.reason === "procurement_released") return "On a released purchase order"
  return null
}

/**
 * The home's selection exceptions: choices it can no longer have as made, each
 * with the way out it allows — an alternate still in time, a change order, an
 * approved expedite, or a variance order raised by hand.
 */
export function SelectionExceptionsBand({
  projectId,
  exceptions,
  truncated,
  error,
}: {
  projectId: string
  exceptions: HomeSelectionException[]
  truncated: boolean
  error: string | null
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [alternateByException, setAlternateByException] = useState<Record<string, string>>({})
  const [closing, setClosing] = useState<Closing | null>(null)

  if (error) {
    return (
      <section className="border border-destructive/40 px-3 py-2 text-sm text-destructive" role="alert">
        Selection exceptions could not be loaded: {error}
      </section>
    )
  }
  if (!exceptions.length) return null
  const open = exceptions.filter((exception) => exception.status === "open")

  function choose(exception: HomeSelectionException) {
    const optionId = alternateByException[exception.id] ?? exception.alternates[0]?.optionId
    if (!optionId) return
    startTransition(async () => {
      const result = await chooseSelectionAlternateAction({ exceptionId: exception.id, optionId })
      if (!result.success) {
        toast.error("Could not choose the alternate", { description: result.error })
        return
      }
      toast.success("Alternate chosen")
      router.refresh()
    })
  }

  function submitClosing(formData: FormData) {
    if (!closing) return
    startTransition(async () => {
      const result = await closeSelectionExceptionAction({
        exceptionId: closing.exception.id,
        resolution: closing.resolution,
        reason: String(formData.get("reason") ?? ""),
      })
      if (!result.success) {
        toast.error("Could not close the exception", { description: result.error })
        return
      }
      setClosing(null)
      toast.success(CLOSING_COPY[closing.resolution].action)
      router.refresh()
    })
  }

  return (
    <section className="border" aria-labelledby="selection-exceptions-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
        <div className="flex items-center gap-2">
          <h2 id="selection-exceptions-title" className="text-sm font-semibold">Supply exceptions</h2>
          <Badge variant={open.length ? "destructive" : "secondary"} className="tabular-nums">{open.length} open</Badge>
        </div>
        {truncated && <span className="text-xs text-muted-foreground">Showing the most recent exceptions only</span>}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Selection</TableHead>
            <TableHead>Exception</TableHead>
            <TableHead>Detail</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[360px] text-right">Resolve</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {exceptions.map((exception) => {
            const detail = exceptionDetail(exception)
            const isOpen = exception.status === "open"
            const answerable = isOpen && (exception.reason === "option_unavailable" || exception.reason === "lead_time_exceeded")
            return (
              <TableRow key={exception.id} className={isOpen ? undefined : "text-muted-foreground"}>
                <TableCell className="font-medium">
                  {exception.category_name}
                  {exception.option_name && <span className="block text-xs font-normal text-muted-foreground">{exception.option_name}</span>}
                </TableCell>
                <TableCell>
                  <span className={isOpen ? "text-warning" : undefined}>{SELECTION_EXCEPTION_REASON_LABELS[exception.reason]}</span>
                </TableCell>
                <TableCell className="text-xs tabular-nums">{detail ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={isOpen ? "outline" : "secondary"}>{SELECTION_EXCEPTION_STATUS_LABELS[exception.status]}</Badge>
                  {exception.resolution_reason && <span className="block text-xs text-muted-foreground" title={exception.resolution_reason}>{exception.resolution_reason}</span>}
                </TableCell>
                <TableCell className="text-right">
                  {isOpen && (
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {answerable && exception.alternates.length > 0 && (
                        <>
                          <Select
                            value={alternateByException[exception.id] ?? exception.alternates[0].optionId}
                            onValueChange={(value) => setAlternateByException((current) => ({ ...current, [exception.id]: value }))}
                          >
                            <SelectTrigger className="h-7 w-[170px] text-xs" aria-label="Alternate option">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {exception.alternates.map((alternate) => (
                                <SelectItem key={alternate.optionId} value={alternate.optionId}>
                                  {alternate.name} · {money.format(alternate.priceCents / 100)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button size="sm" variant="outline" className="h-7" disabled={isPending} onClick={() => choose(exception)}>Choose</Button>
                        </>
                      )}
                      {answerable && exception.alternates.length === 0 && <span className="text-xs text-muted-foreground">No alternate in time</span>}
                      {exception.reason !== "variance_unrouted" && (
                        <Button asChild size="sm" variant="ghost" className="h-7">
                          <a href={`/projects/${projectId}/change-orders?selection=${exception.selection_id}`}>Change order</a>
                        </Button>
                      )}
                      {exception.reason === "lead_time_exceeded" && (
                        <Button size="sm" variant="ghost" className="h-7" disabled={isPending} onClick={() => setClosing({ exception, resolution: "waived" })}>Expedite</Button>
                      )}
                      {exception.reason === "variance_unrouted" && (
                        <Button size="sm" variant="outline" className="h-7" disabled={isPending} onClick={() => setClosing({ exception, resolution: "resolved_manual" })}>Mark handled</Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 text-muted-foreground" disabled={isPending} onClick={() => setClosing({ exception, resolution: "void" })}>Dismiss</Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <Dialog open={Boolean(closing)} onOpenChange={(next) => { if (!next) setClosing(null) }}>
        <DialogContent>
          {closing && (
            <form action={submitClosing}>
              <DialogHeader>
                <DialogTitle>{CLOSING_COPY[closing.resolution].title}</DialogTitle>
                <DialogDescription>{CLOSING_COPY[closing.resolution].description}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2 py-4">
                <Label htmlFor="exception-reason">Reason</Label>
                <Input id="exception-reason" name="reason" required minLength={5} maxLength={500} />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={isPending}>{CLOSING_COPY[closing.resolution].action}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </section>
  )
}
