"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { format } from "date-fns"
import { ArrowLeft, Copy, Download, Loader2, MoreHorizontal, Send } from "lucide-react"
import { toast } from "sonner"

import type { Invoice, InvoiceLienWaiver, InvoiceLienWaiverType, Payment } from "@/lib/types"
import { INVOICE_WAIVER_TYPES, INVOICE_WAIVER_TYPE_LABELS } from "@/lib/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArcInvoiceDocument, toArcInvoiceData, toArcInvoiceLines } from "@/components/invoices/arc-invoice-document"
import { QBOSyncBadge } from "@/components/invoices/qbo-sync-badge"
import {
  createInvoiceLienWaiverAction,
  generateInvoicePdfAction,
  sendInvoiceReminderAction,
} from "@/app/(app)/invoices/actions"
import { recordPaymentAction } from "@/app/(app)/payments/actions"
import { voidInvoiceLienWaiverAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"

import { balanceCentsOf, customerNameOf, displayStatusKey, isOpenInvoice, resolveStatusKey } from "./receivables-filters"
import { formatMoneyFromCents, invoiceStatusBadge } from "./invoice-ui"

async function openPdfUrl(url: string, fileName?: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" })
  if (!response.ok) throw new Error("Unable to open generated PDF")
  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const popup = window.open(objectUrl, "_blank", "noopener,noreferrer")
  if (!popup) {
    const link = document.createElement("a")
    link.href = objectUrl
    link.download = fileName || "invoice.pdf"
    document.body.appendChild(link)
    link.click()
    link.remove()
  }
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

interface InvoiceReadViewProps {
  invoice: Invoice
  link?: string
  payments?: Payment[]
  lienWaivers?: InvoiceLienWaiver[]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  projectName?: string | null
  onBack: () => void
  onCopyLink: () => void
  onDuplicate: () => void
  onMakeRecurring: () => void
  onRevise: () => void
  onVoid: () => void
  onResync: () => Promise<void>
  onChanged: () => Promise<void> | void
}

export function InvoiceReadView({
  invoice,
  link,
  payments,
  lienWaivers,
  builderInfo,
  projectName,
  onBack,
  onCopyLink,
  onDuplicate,
  onMakeRecurring,
  onRevise,
  onVoid,
  onResync,
  onChanged,
}: InvoiceReadViewProps) {
  const [pdfLoading, setPdfLoading] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  const [sendingReminder, setSendingReminder] = useState(false)
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState<"ach" | "card" | "wire" | "check">("ach")
  const [paymentReference, setPaymentReference] = useState("")
  const [paymentDate, setPaymentDate] = useState(format(new Date(), "yyyy-MM-dd"))
  const [recordingPayment, setRecordingPayment] = useState(false)
  const [waiverType, setWaiverType] = useState<InvoiceLienWaiverType>("conditional_progress")
  const [creatingWaiver, setCreatingWaiver] = useState(false)
  const [voidingWaiverId, setVoidingWaiverId] = useState<string | null>(null)

  const documentData = useMemo(
    () =>
      toArcInvoiceData(invoice, {
        name: builderInfo?.name ?? null,
        email: builderInfo?.email ?? null,
        address: builderInfo?.address ?? null,
        projectName: projectName ?? null,
        payUrl: link ?? null,
      }),
    [invoice, builderInfo, projectName, link],
  )
  const documentLines = useMemo(() => toArcInvoiceLines(invoice), [invoice])

  const balanceDue = balanceCentsOf(invoice)
  const status = displayStatusKey(invoice)
  const wasSent = Boolean(invoice.sent_at) || ["sent", "partial", "overdue"].includes(status)
  const canRecordPayment = !["paid", "void"].includes(resolveStatusKey(invoice.status)) && balanceDue > 0

  const measureRef = useRef<HTMLDivElement>(null)
  const [docWidth, setDocWidth] = useState(720)
  useEffect(() => {
    const el = measureRef.current
    if (!el) return
    const update = () => setDocWidth(Math.max(360, Math.min(820, el.clientWidth - 32)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleDownloadPdf = async () => {
    setPdfLoading(true)
    try {
      const result = unwrapAction(await generateInvoicePdfAction(invoice.id, { persistToArc: true }))
      if (result.downloadUrl && typeof window !== "undefined") await openPdfUrl(result.downloadUrl, result.fileName)
      toast.success("Invoice PDF saved to Arc")
    } catch (error: any) {
      toast.error("Failed to generate invoice PDF", { description: error?.message ?? "Please try again." })
    } finally {
      setPdfLoading(false)
    }
  }

  const handleResync = async () => {
    setResyncing(true)
    try {
      await onResync()
    } finally {
      setResyncing(false)
    }
  }

  const handleSendReminder = async () => {
    setSendingReminder(true)
    try {
      unwrapAction(await sendInvoiceReminderAction(invoice.id))
      toast.success("Reminder sent")
    } catch (error: any) {
      toast.error("Could not send reminder", { description: error?.message ?? "Please try again." })
    } finally {
      setSendingReminder(false)
    }
  }

  const openPaymentDialog = () => {
    setPaymentAmount((balanceDue / 100).toFixed(2))
    setPaymentMethod("ach")
    setPaymentReference("")
    setPaymentDate(format(new Date(), "yyyy-MM-dd"))
    setPaymentDialogOpen(true)
  }

  const handleRecordPayment = async () => {
    const amountCents = Math.round(Number(paymentAmount) * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      toast.error("Enter a payment amount")
      return
    }
    if (amountCents > balanceDue) {
      toast.error("Payment is greater than the balance due")
      return
    }
    const receivedAt = paymentDate ? new Date(`${paymentDate}T12:00:00`) : null
    if (receivedAt && Number.isNaN(receivedAt.getTime())) {
      toast.error("Enter a valid payment date")
      return
    }
    if (receivedAt && receivedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      toast.error("Payment date cannot be in the future")
      return
    }
    setRecordingPayment(true)
    try {
      unwrapAction(
        await recordPaymentAction({
          invoice_id: invoice.id,
          provider: "manual",
          provider_payment_id: `manual:${invoice.id}:${Date.now()}`,
          amount_cents: amountCents,
          currency: "usd",
          method: paymentMethod,
          status: "succeeded",
          reference: paymentReference.trim() || undefined,
          received_at: receivedAt ? receivedAt.toISOString() : undefined,
          metadata: { source: "arc_manual_invoice_payment" },
        }),
      )
      toast.success(amountCents >= balanceDue ? "Invoice marked paid" : "Payment recorded")
      setPaymentDialogOpen(false)
      await onChanged()
    } catch (error: any) {
      toast.error("Could not record payment", { description: error?.message ?? "Please try again." })
    } finally {
      setRecordingPayment(false)
    }
  }

  const handleCreateWaiver = async () => {
    setCreatingWaiver(true)
    try {
      unwrapAction(await createInvoiceLienWaiverAction({ invoiceId: invoice.id, waiverType }))
      toast.success("Lien waiver attached")
      await onChanged()
    } catch (error: any) {
      toast.error("Could not create lien waiver", { description: error?.message ?? "Please try again." })
    } finally {
      setCreatingWaiver(false)
    }
  }

  const handleVoidWaiver = async (waiverId: string) => {
    setVoidingWaiverId(waiverId)
    try {
      unwrapAction(await voidInvoiceLienWaiverAction(waiverId))
      toast.success("Lien waiver voided")
      await onChanged()
    } catch (error: any) {
      toast.error("Could not void lien waiver", { description: error?.message ?? "Please try again." })
    } finally {
      setVoidingWaiverId(null)
    }
  }

  const appliedPayments = (payments ?? []).filter((p) => p.status === "succeeded")
  const totalAppliedCents = appliedPayments.reduce((sum, p) => sum + p.amount_cents, 0)
  const waivers = lienWaivers ?? []

  return (
    <>
      {/* Header */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={onBack} title="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold leading-tight">Invoice {invoice.invoice_number}</h2>
            <p className="truncate text-xs text-muted-foreground">{customerNameOf(invoice) || "No customer"}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {invoiceStatusBadge(invoice)}
          {invoice.qbo_sync_status ? (
            <QBOSyncBadge status={invoice.qbo_sync_status} syncedAt={invoice.qbo_synced_at ?? undefined} qboId={invoice.qbo_id ?? undefined} />
          ) : null}
          {canRecordPayment ? (
            <Button size="sm" variant="secondary" className="h-8 text-xs" onClick={openPaymentDialog}>
              Record payment
            </Button>
          ) : null}
          {wasSent ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5 text-xs" onClick={onCopyLink} disabled={!link}>
              <Copy className="h-3.5 w-3.5" />
              Copy link
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Invoice actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={handleDownloadPdf} disabled={pdfLoading}>
                {pdfLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                Download PDF
              </DropdownMenuItem>
              {wasSent ? (
                <DropdownMenuItem onClick={handleSendReminder} disabled={sendingReminder || !isOpenInvoice(invoice)}>
                  <Send className="mr-2 h-4 w-4" />
                  {sendingReminder ? "Sending…" : "Send reminder"}
                </DropdownMenuItem>
              ) : null}
              {invoice.qbo_sync_status ? (
                <DropdownMenuItem onClick={handleResync} disabled={resyncing}>
                  {resyncing ? "Syncing…" : "Sync to QuickBooks"}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onDuplicate}>Duplicate invoice</DropdownMenuItem>
              <DropdownMenuItem onClick={onMakeRecurring} disabled={resolveStatusKey(invoice.status) === "void"}>
                Make recurring…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onRevise}
                disabled={["draft", "saved", "partial", "paid", "void"].includes(resolveStatusKey(invoice.status))}
              >
                Revise and reissue
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={onVoid}
                disabled={["paid", "partial", "void"].includes(resolveStatusKey(invoice.status))}
                className="text-destructive focus:text-destructive"
              >
                Void invoice
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Document + inline actions */}
      <div ref={measureRef} className="min-h-0 flex-1 space-y-6 overflow-y-auto bg-muted/20 px-4 py-6 sm:px-6">
        <div className="mx-auto w-fit border shadow-sm">
          <ArcInvoiceDocument data={documentData} lines={documentLines} width={docWidth} height={docWidth * 1.294} />
        </div>

        {appliedPayments.length > 0 ? (
          <section className="mx-auto max-w-[820px] space-y-3 border bg-card p-4">
            <div className="flex items-center justify-between">
              <h3 className="microlabel">Payments applied</h3>
              <span className="text-xs text-muted-foreground">
                {formatMoneyFromCents(totalAppliedCents)} of {formatMoneyFromCents(invoice.total_cents ?? invoice.totals?.total_cents ?? 0)}
              </span>
            </div>
            <div className="divide-y border bg-background">
              {appliedPayments.map((payment) => (
                <div key={payment.id} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                  <span className="truncate text-xs text-muted-foreground">
                    {payment.received_at ? format(new Date(payment.received_at), "MMM d, yyyy") : "No date"}
                    {payment.reference ? ` • ${payment.reference}` : ""}
                  </span>
                  <span className="shrink-0 font-mono font-medium tabular-nums text-success">{formatMoneyFromCents(payment.amount_cents)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mx-auto max-w-[820px] space-y-3 border bg-card p-4">
          <h3 className="microlabel">Lien waivers</h3>
          {waivers.length > 0 ? (
            <div className="space-y-2">
              {waivers.map((waiver) => (
                <div key={waiver.id} className="flex items-center justify-between gap-2 border bg-background px-3 py-2 text-sm">
                  <span className="min-w-0 truncate font-medium">{INVOICE_WAIVER_TYPE_LABELS[waiver.waiver_type] ?? waiver.waiver_type}</span>
                  <span className="flex shrink-0 items-center gap-3 text-xs">
                    <span className={waiver.status === "released" ? "text-success" : "text-warning"}>
                      {waiver.status === "released" ? "Released" : "Pending payment"}
                    </span>
                    {link ? (
                      <a href={`${link}/waiver/${waiver.id}`} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
                        View PDF
                      </a>
                    ) : null}
                    {waiver.status === "pending_payment" ? (
                      <button type="button" className="text-destructive underline underline-offset-2 disabled:opacity-50" disabled={voidingWaiverId === waiver.id} onClick={() => handleVoidWaiver(waiver.id)}>
                        {voidingWaiverId === waiver.id ? "Voiding…" : "Void"}
                      </button>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No lien waivers attached.</p>
          )}
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <Select value={waiverType} onValueChange={(value) => setWaiverType(value as InvoiceLienWaiverType)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVOICE_WAIVER_TYPES.map((type) => (
                  <SelectItem key={type} value={type} disabled={waivers.some((w) => w.waiver_type === type)}>
                    {INVOICE_WAIVER_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              disabled={creatingWaiver || resolveStatusKey(invoice.status) === "void" || waivers.some((w) => w.waiver_type === waiverType)}
              onClick={handleCreateWaiver}
            >
              {creatingWaiver ? "Attaching…" : "Attach"}
            </Button>
          </div>
        </section>
      </div>

      <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record payment</DialogTitle>
            <DialogDescription>
              Add a manual payment for {invoice.invoice_number}. This updates the Arc balance and queues the payment for QuickBooks sync.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="ws-invoice-payment-amount">Amount</label>
              <Input id="ws-invoice-payment-amount" type="number" min="0" step="0.01" value={paymentAmount} onChange={(event) => setPaymentAmount(event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="ws-invoice-payment-date">Payment date</label>
              <Input id="ws-invoice-payment-date" type="date" max={format(new Date(), "yyyy-MM-dd")} value={paymentDate} onChange={(event) => setPaymentDate(event.target.value)} />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Method</label>
              <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as typeof paymentMethod)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ach">ACH</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="wire">Wire</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="ws-invoice-payment-reference">Reference</label>
              <Input id="ws-invoice-payment-reference" value={paymentReference} onChange={(event) => setPaymentReference(event.target.value)} placeholder="Check number, note, or QBO payment ref" />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPaymentDialogOpen(false)} disabled={recordingPayment}>Cancel</Button>
            <Button type="button" onClick={handleRecordPayment} disabled={recordingPayment}>
              {recordingPayment ? "Recording..." : "Record payment"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
