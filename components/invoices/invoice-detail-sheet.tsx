"use client"

import type React from "react"
import { useMemo, useEffect, useState } from "react"
import { format } from "date-fns"
import { Copy, ExternalLink, Download, RefreshCw } from "lucide-react"

import type { Invoice, InvoiceLienWaiver, InvoiceLienWaiverType, InvoiceView, Payment, PaymentReversal } from "@/lib/types"
import { INVOICE_WAIVER_TYPES, INVOICE_WAIVER_TYPE_LABELS } from "@/lib/types"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { QBOSyncBadge } from "@/components/invoices/qbo-sync-badge"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions"
import {
  createInvoiceLienWaiverAction,
  generateInvoicePdfAction,
  updateInvoiceNotesAction,
  voidInvoiceLienWaiverAction,
} from "@/app/(app)/invoices/actions"
import { recordPaymentAction } from "@/app/(app)/payments/actions"
import { unwrapAction } from "@/lib/action-result"
import { toast } from "sonner"

type AttachmentLink = Awaited<ReturnType<typeof listAttachmentsAction>>[number]

function mapAttachmentLinks(links: AttachmentLink[]): AttachedFile[] {
  return links.map((link) => ({
    id: link.file.id,
    linkId: link.id,
    file_name: link.file.file_name,
    mime_type: link.file.mime_type,
    size_bytes: link.file.size_bytes,
    download_url: link.file.download_url,
    thumbnail_url: link.file.thumbnail_url,
    created_at: link.created_at,
    link_role: link.link_role,
  }))
}

/** Turn a raw user-agent string into something a builder can read at a glance. */
function describeUserAgent(ua?: string | null): string | null {
  if (!ua) return null
  const device = /iphone/i.test(ua)
    ? "iPhone"
    : /ipad/i.test(ua)
      ? "iPad"
      : /android/i.test(ua)
        ? "Android"
        : /macintosh|mac os x/i.test(ua)
          ? "Mac"
          : /windows/i.test(ua)
            ? "Windows"
            : null
  const browser = /edg\//i.test(ua)
    ? "Edge"
    : /chrome|crios/i.test(ua)
      ? "Chrome"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /safari/i.test(ua)
          ? "Safari"
          : null
  const parts = [device, browser].filter(Boolean)
  return parts.length > 0 ? parts.join(" · ") : null
}

type Props = {
  trigger?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice?: Invoice | null
  link?: string
  views?: InvoiceView[]
  syncHistory?: Array<{ id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }>
  payments?: Payment[]
  reversals?: PaymentReversal[]
  lienWaivers?: InvoiceLienWaiver[]
  loading?: boolean
  onCopyLink?: () => void
  onManualResync?: () => Promise<void>
  manualResyncing?: boolean
  onEdit?: () => void
  onRevise?: () => void
  onPaymentRecorded?: () => Promise<void> | void
  onWaiversChanged?: () => Promise<void> | void
}

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function paymentSourceLabel(payment: Payment): string {
  const metaSource = (payment.metadata as Record<string, any> | undefined)?.source
  const hasAllocation = Boolean((payment.metadata as Record<string, any> | undefined)?.payment_allocation_id)
  if (payment.provider === "qbo") {
    if (hasAllocation || metaSource === "payment_allocation") return "QuickBooks allocation"
    return metaSource === "client_deposit" ? "Client deposit · QuickBooks" : "QuickBooks"
  }
  if (payment.provider === "stripe") return "Online payment"
  if (payment.provider === "manual") return "Manual"
  return payment.provider ? payment.provider : "Payment"
}

function paymentMethodLabel(method?: string | null): string | null {
  if (!method) return null
  switch (method) {
    case "ach":
      return "ACH"
    case "card":
      return "Card"
    case "wire":
      return "Wire"
    case "check":
      return "Check"
    case "other":
      return null
    default:
      return method.charAt(0).toUpperCase() + method.slice(1)
  }
}

const REVERSAL_TYPE_LABEL: Record<string, string> = {
  refund: "Refund",
  ach_return: "ACH return",
  chargeback: "Chargeback",
  dispute: "Dispute",
  correction: "Correction",
}

async function openPdfUrl(url: string, fileName?: string) {
  const response = await fetch(url, { credentials: "include", cache: "no-store" })
  if (!response.ok) {
    throw new Error("Unable to open generated PDF")
  }
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

type CopyInputProps = { value: string; actions?: React.ReactNode }

function CopyInput({ value, actions }: CopyInputProps) {
  return (
    <div className="relative flex items-center">
      <Input readOnly value={value} className="pr-24 text-sm" />
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {actions}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={async () => {
            try {
              if (typeof navigator !== "undefined" && navigator.clipboard) {
                await navigator.clipboard.writeText(value)
              }
            } catch (err) {
              console.error("Copy failed", err)
            }
          }}
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

export function InvoiceDetailSheet({
  trigger,
  open,
  onOpenChange,
  invoice,
  link,
  views,
  syncHistory,
  payments,
  reversals,
  lienWaivers,
  loading,
  onCopyLink,
  onManualResync,
  manualResyncing,
  onEdit,
  onRevise,
  onPaymentRecorded,
  onWaiversChanged,
}: Props) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState("")
  const [paymentMethod, setPaymentMethod] = useState<"ach" | "card" | "wire" | "check">("ach")
  const [paymentReference, setPaymentReference] = useState("")
  const [paymentDate, setPaymentDate] = useState("")
  const [recordingPayment, setRecordingPayment] = useState(false)
  const [notesDraft, setNotesDraft] = useState("")
  const [savingNotes, setSavingNotes] = useState(false)
  const [waiverType, setWaiverType] = useState<InvoiceLienWaiverType>("conditional_progress")
  const [creatingWaiver, setCreatingWaiver] = useState(false)
  const [voidingWaiverId, setVoidingWaiverId] = useState<string | null>(null)

  useEffect(() => {
    setNotesDraft(invoice?.notes ?? "")
  }, [invoice?.id, invoice?.notes])

  useEffect(() => {
    if (!open || !invoice?.id) return
    setAttachmentsLoading(true)
    listAttachmentsAction("invoice", invoice.id)
      .then((links) => setAttachments(mapAttachmentLinks(links)))
      .catch((error) => console.error("Failed to load invoice attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [open, invoice?.id])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!invoice) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      if (invoice.project_id) {
        formData.append("projectId", invoice.project_id)
      }
      formData.append("category", "financials")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "invoice", invoice.id, invoice.project_id ?? undefined, linkRole)
    }

    const links = await listAttachmentsAction("invoice", invoice.id)
    setAttachments(mapAttachmentLinks(links))
  }

  const handleDetach = async (linkId: string) => {
    if (!invoice) return
    await detachFileLinkAction(linkId)
    const links = await listAttachmentsAction("invoice", invoice.id)
    setAttachments(mapAttachmentLinks(links))
  }

  const handleCreateWaiver = async () => {
    if (!invoice?.id) return
    setCreatingWaiver(true)
    try {
      unwrapAction(await createInvoiceLienWaiverAction({ invoiceId: invoice.id, waiverType }))
      toast.success("Lien waiver attached", {
        description: waiverType.startsWith("conditional")
          ? "The client can view it now; it releases automatically when the invoice is paid."
          : "It will be available to the client once the invoice is paid.",
      })
      await onWaiversChanged?.()
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
      await onWaiversChanged?.()
    } catch (error: any) {
      toast.error("Could not void lien waiver", { description: error?.message ?? "Please try again." })
    } finally {
      setVoidingWaiverId(null)
    }
  }

  const handleSaveNotes = async () => {
    if (!invoice?.id) return
    setSavingNotes(true)
    try {
      unwrapAction(await updateInvoiceNotesAction(invoice.id, notesDraft))
      toast.success("Notes saved")
    } catch (error: any) {
      toast.error("Could not save notes", { description: error?.message ?? "Please try again." })
    } finally {
      setSavingNotes(false)
    }
  }

  const loadingView = (
    <div className="px-5 pt-6 pb-4 space-y-4 animate-pulse">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-full bg-muted" />
          <div className="flex flex-col gap-1">
            <div className="h-3 w-32 rounded bg-muted" />
            <div className="h-3 w-24 rounded bg-muted" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-6 w-16 rounded bg-muted" />
          <div className="h-6 w-16 rounded bg-muted" />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <div className="h-8 w-24 rounded bg-muted" />
        <div className="grid grid-cols-2 gap-3">
          <div className="h-9 rounded bg-muted" />
          <div className="h-9 rounded bg-muted" />
        </div>
      </div>
      <div className="space-y-3">
        {[...Array(4)].map((_, idx) => (
          <div key={idx} className="flex items-center justify-between text-sm text-muted-foreground">
            <span className="h-3 w-20 rounded bg-muted" />
            <span className="h-3 w-24 rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )

  const subtotal = invoice?.totals?.subtotal_cents ?? invoice?.subtotal_cents ?? 0
  const tax = invoice?.totals?.tax_cents ?? invoice?.tax_cents ?? 0
  const total = invoice?.totals?.total_cents ?? invoice?.total_cents ?? subtotal + tax
  const balanceDue = invoice?.balance_due_cents ?? invoice?.totals?.balance_due_cents ?? total
  const canRecordPayment = Boolean(invoice?.id && !["paid", "void"].includes(String(invoice?.status ?? "")) && balanceDue > 0)
  const metadata = (invoice?.metadata as Record<string, any>) ?? {}
  const sentToArray = invoice?.sent_to_emails ?? (metadata.sent_to ?? metadata.sentTo ?? []) ?? []
  const customerName = (invoice?.customer_name as string | undefined) ?? metadata.customer_name ?? sentToArray?.[0] ?? "Customer"
  const customerInitial = customerName?.[0] ?? "C"
  const numberAdjustedByQbo = Boolean(metadata.invoice_number_changed)
  const previousInvoiceNumber = metadata.invoice_number_previous as string | undefined
  const sentAtValue = (invoice as any)?.sent_at ?? metadata.sent_at ?? metadata.sentAt
  const sentToValue =
    typeof sentToArray === "string"
      ? sentToArray
      : Array.isArray(sentToArray)
        ? sentToArray.filter(Boolean).join(", ")
        : undefined

  const isClientDeposit = metadata.source === "client_deposit"

  const reversalsByPayment = useMemo(() => {
    const map = new Map<string, number>()
    for (const reversal of reversals ?? []) {
      if (reversal.status === "failed") continue
      map.set(reversal.payment_id, (map.get(reversal.payment_id) ?? 0) + reversal.amount_cents)
    }
    return map
  }, [reversals])

  const appliedPayments = useMemo(
    () => (payments ?? []).filter((p) => p.status === "succeeded"),
    [payments],
  )

  const totalAppliedCents = useMemo(
    () =>
      appliedPayments.reduce(
        (sum, p) => sum + p.amount_cents - (reversalsByPayment.get(p.id) ?? 0),
        0,
      ),
    [appliedPayments, reversalsByPayment],
  )

  // One chronological story of the invoice: created → sent → viewed → paid/reversed.
  const timeline = useMemo(() => {
    type TimelineEntry = { id: string; at: string; label: string; detail?: string | null; tone?: "default" | "positive" | "destructive" }
    const entries: TimelineEntry[] = []
    if (invoice?.created_at) {
      entries.push({ id: "created", at: invoice.created_at, label: "Invoice created" })
    }
    if (sentAtValue) {
      entries.push({ id: "sent", at: String(sentAtValue), label: "Sent to client", detail: sentToValue ?? null })
    }
    for (const view of views ?? []) {
      entries.push({ id: `view-${view.id}`, at: view.viewed_at, label: "Viewed by client", detail: describeUserAgent(view.user_agent) })
    }
    for (const payment of appliedPayments) {
      entries.push({
        id: `payment-${payment.id}`,
        at: payment.received_at,
        label: `Payment · ${formatMoneyFromCents(payment.amount_cents)}`,
        detail: paymentSourceLabel(payment),
        tone: "positive",
      })
    }
    for (const reversal of reversals ?? []) {
      if (reversal.status === "failed") continue
      entries.push({
        id: `reversal-${reversal.id}`,
        at: reversal.occurred_at ?? reversal.created_at ?? "",
        label: `${REVERSAL_TYPE_LABEL[reversal.reversal_type] ?? reversal.reversal_type} · −${formatMoneyFromCents(reversal.amount_cents)}`,
        detail: reversal.reason ?? null,
        tone: "destructive",
      })
    }
    return entries
      .filter((entry) => entry.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  }, [invoice?.created_at, sentAtValue, sentToValue, views, appliedPayments, reversals])

  const syncLogs = useMemo(() => {
    return (syncHistory ?? []).map((item) => ({
      id: item.id,
      status: item.status,
      last_synced_at: item.last_synced_at,
      error: item.error_message,
      qbo_id: item.qbo_id,
    }))
  }, [syncHistory])

  const handleDownloadPdf = async () => {
    if (!invoice?.id) return
    setPdfLoading(true)
    try {
      const result = unwrapAction(await generateInvoicePdfAction(invoice.id, { persistToArc: true }))
      if (result.downloadUrl && typeof window !== "undefined") {
        await openPdfUrl(result.downloadUrl, result.fileName)
      }
      toast.success("Invoice PDF saved to Arc")
    } catch (error: any) {
      toast.error("Failed to generate invoice PDF", { description: error?.message ?? "Please try again." })
    } finally {
      setPdfLoading(false)
    }
  }

  const openRecordPaymentDialog = () => {
    setPaymentAmount(((balanceDue ?? 0) / 100).toFixed(2))
    setPaymentMethod("ach")
    setPaymentReference("")
    setPaymentDate(format(new Date(), "yyyy-MM-dd"))
    setPaymentDialogOpen(true)
  }

  const handleRecordPayment = async () => {
    if (!invoice?.id) return
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
        metadata: {
          source: "arc_manual_invoice_payment",
        },
      })
      toast.success(amountCents >= balanceDue ? "Invoice marked paid" : "Payment recorded")
      setPaymentDialogOpen(false)
      await onPaymentRecorded?.()
    } catch (error: any) {
      toast.error("Could not record payment", { description: error?.message ?? "Please try again." })
    } finally {
      setRecordingPayment(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] overflow-hidden shadow-2xl flex flex-col bg-white dark:bg-[#0C0C0C] gap-0 [&>button]:hidden fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as React.CSSProperties}
      >
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 pt-6 pb-4 space-y-4">
            {loading ? (
              loadingView
            ) : (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Avatar className="size-9">
                      <AvatarFallback className="text-xs font-medium">{customerInitial}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="text-base font-semibold leading-tight line-clamp-1">{customerName}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {invoice?.qbo_sync_status && (
                      <QBOSyncBadge
                        status={invoice.qbo_sync_status}
                        syncedAt={invoice.qbo_synced_at ?? undefined}
                        qboId={invoice.qbo_id ?? undefined}
                      />
                    )}
                    {isClientDeposit && (
                      <Badge variant="outline" className="border-blue-300 text-blue-700 dark:border-blue-900 dark:text-blue-300">
                        Client deposit
                      </Badge>
                    )}
                    {invoice?.status && <Badge className="capitalize">{invoice.status}</Badge>}
                  </div>
                </div>

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-4xl font-semibold leading-none select-text">
                      {formatMoneyFromCents(balanceDue > 0 && balanceDue < total ? balanceDue : total)}
                    </span>
                    {balanceDue > 0 && balanceDue < total ? (
                      <span className="text-sm text-muted-foreground">
                        balance due of {formatMoneyFromCents(total)} total
                      </span>
                    ) : null}
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <span
                      title={
                        canRecordPayment
                          ? undefined
                          : invoice?.status === "void"
                            ? "Voided invoices cannot take payments"
                            : "This invoice has no outstanding balance"
                      }
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="w-full justify-center"
                        onClick={openRecordPaymentDialog}
                        disabled={!canRecordPayment}
                      >
                        Record payment
                      </Button>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-center"
                      onClick={onEdit ?? onRevise}
                      disabled={!onEdit && !onRevise}
                    >
                      {onEdit ? "Edit" : "Revise"}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </div>

          <Separator className="my-4" />

          {loading ? (
            <div className="px-5 py-5 space-y-3 animate-pulse">
              {[...Array(5)].map((_, idx) => (
                <div key={idx} className="flex items-center justify-between text-sm text-muted-foreground">
                  <span className="h-3 w-24 rounded bg-muted" />
                  <span className="h-3 w-28 rounded bg-muted" />
                </div>
              ))}
            </div>
          ) : (
            <div className="px-5 py-5 space-y-4">
            {numberAdjustedByQbo && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Invoice number updated after a QuickBooks conflict
                {previousInvoiceNumber ? ` (previous: ${previousInvoiceNumber}).` : "."}
              </div>
            )}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Due date</span>
              <span className="text-foreground">
                {invoice?.due_date ? format(new Date(invoice.due_date), "MMM dd, yyyy") : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Issue date</span>
              <span className="text-foreground">
                {invoice?.issue_date ? format(new Date(invoice.issue_date), "MMM dd, yyyy") : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Sent at</span>
              <span className="text-foreground">
                {sentAtValue ? format(new Date(sentAtValue), "MMM dd, yyyy") : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Sent to</span>
              <span className="text-foreground">{sentToValue ?? "—"}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Balance due</span>
              <span className="text-foreground">{formatMoneyFromCents(balanceDue)}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Invoice no.</span>
              <span className="text-foreground">{invoice?.invoice_number ?? "—"}</span>
            </div>
          </div>
          )}

          {!loading && (payments ?? []).length > 0 && (
            <>
              <Separator className="my-2" />
              <div className="px-5 py-5 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Payments applied</span>
                  <span className="text-sm text-muted-foreground">
                    {formatMoneyFromCents(totalAppliedCents)} of {formatMoneyFromCents(total)}
                  </span>
                </div>
                <div className="space-y-2">
                  {appliedPayments.map((payment) => {
                    const reversedCents = reversalsByPayment.get(payment.id) ?? 0
                    const methodLabel = paymentMethodLabel(payment.method)
                    return (
                      <div key={payment.id} className="rounded-md border px-3 py-2 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="font-medium">{formatMoneyFromCents(payment.amount_cents)}</span>
                            <Badge variant="secondary" className="shrink-0 text-[10px] font-normal">
                              {paymentSourceLabel(payment)}
                            </Badge>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {payment.received_at ? format(new Date(payment.received_at), "MMM d, yyyy") : "—"}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="truncate">
                            {[methodLabel, payment.reference].filter(Boolean).join(" · ") || "—"}
                          </span>
                          {reversedCents > 0 && (
                            <span className="shrink-0 font-medium text-destructive">
                              −{formatMoneyFromCents(reversedCents)} reversed
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
                {(reversals ?? []).length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    {(reversals ?? []).map((reversal) => (
                      <div
                        key={reversal.id}
                        className="flex items-center justify-between gap-2 text-xs text-muted-foreground"
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="font-medium text-destructive">
                            {REVERSAL_TYPE_LABEL[reversal.reversal_type] ?? reversal.reversal_type}
                          </span>
                          {reversal.status !== "succeeded" && (
                            <span className="capitalize">({reversal.status})</span>
                          )}
                          {reversal.reason ? <span className="truncate">· {reversal.reason}</span> : null}
                        </span>
                        <span className="shrink-0">
                          −{formatMoneyFromCents(reversal.amount_cents)}
                          {reversal.occurred_at
                            ? ` · ${format(new Date(reversal.occurred_at), "MMM d, yyyy")}`
                            : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          <Separator className="my-2" />

          {loading ? (
            <div className="px-5 py-5 space-y-3 animate-pulse">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="h-9 rounded bg-muted" />
              <div className="flex items-center justify-between mt-2">
                <span className="h-3 w-24 rounded bg-muted" />
                <span className="h-8 w-24 rounded bg-muted" />
              </div>
              <div className="space-y-2">
                {[...Array(2)].map((_, idx) => (
                  <div key={idx} className="h-14 rounded border bg-muted/30" />
                ))}
              </div>
            </div>
          ) : (
            <div className="px-5 py-5 space-y-3">
              <span className="text-sm text-muted-foreground">Invoice link</span>
              <div className="flex w-full items-start gap-2">
                <div className="relative min-w-0 flex-1">
                  <CopyInput
                    value={link ?? "No link yet"}
                    actions={
                      link ? (
                        <Button variant="ghost" size="icon" asChild className="h-8 w-8 text-muted-foreground">
                          <a href={link} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-4 w-4" />
                          </a>
                        </Button>
                      ) : null
                    }
                  />
                </div>
                <Button
                  variant="secondary"
                  className="size-[38px] hover:bg-secondary shrink-0"
                  onClick={handleDownloadPdf}
                  disabled={pdfLoading || !invoice?.id}
                >
                  <Download className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">QuickBooks sync</span>
                {onManualResync && (
                  <Button size="sm" variant="outline" onClick={onManualResync} disabled={manualResyncing}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${manualResyncing ? "animate-spin" : ""}`} />
                    {manualResyncing ? "Syncing..." : "Sync now"}
                  </Button>
                )}
              </div>
              {syncLogs && syncLogs.length > 0 ? (
                <div className="space-y-2">
                  {syncLogs.map((log) => (
                    <div key={log.id} className="rounded-md border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between">
                        <span className="font-medium capitalize">{log.status}</span>
                        <span className="text-xs text-muted-foreground">
                          {log.last_synced_at ? new Date(log.last_synced_at).toLocaleString() : "—"}
                        </span>
                      </div>
                      {log.qbo_id && (
                        <p className="text-xs text-muted-foreground mt-1">QBO ID: {log.qbo_id}</p>
                      )}
                      {log.error && <p className="text-xs text-destructive mt-1">{log.error}</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No syncs yet.</p>
              )}
            </div>
          )}

          {!loading && (
            <Accordion type="multiple" className="px-5 pb-8" defaultValue={["line-items"]}>
              <AccordionItem value="line-items">
                <AccordionTrigger>Line items</AccordionTrigger>
                <AccordionContent>
                  {(invoice?.lines ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No line items on this invoice.</p>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-2">
                        {(invoice?.lines ?? []).map((line, index) => {
                          const lineTotal = Math.round((line.quantity ?? 1) * (line.unit_cost_cents ?? 0))
                          return (
                            <div key={line.id ?? index} className="flex items-start justify-between gap-3 text-sm">
                              <div className="min-w-0">
                                <p className="line-clamp-2">{line.description || "—"}</p>
                                {(line.quantity ?? 1) !== 1 && (
                                  <p className="text-xs text-muted-foreground">
                                    {line.quantity} {line.unit ?? ""} × {formatMoneyFromCents(line.unit_cost_cents)}
                                  </p>
                                )}
                              </div>
                              <span className="shrink-0 font-mono">{formatMoneyFromCents(lineTotal)}</span>
                            </div>
                          )
                        })}
                      </div>
                      <Separator />
                      <div className="space-y-1 text-sm">
                        <div className="flex items-center justify-between text-muted-foreground">
                          <span>Subtotal</span>
                          <span className="font-mono">{formatMoneyFromCents(subtotal)}</span>
                        </div>
                        {tax > 0 && (
                          <div className="flex items-center justify-between text-muted-foreground">
                            <span>Tax</span>
                            <span className="font-mono">{formatMoneyFromCents(tax)}</span>
                          </div>
                        )}
                        <div className="flex items-center justify-between font-medium">
                          <span>Total</span>
                          <span className="font-mono">{formatMoneyFromCents(total)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="attachments">
                <AccordionTrigger>Attachments</AccordionTrigger>
                <AccordionContent>
                  <EntityAttachments
                    entityType="invoice"
                    entityId={invoice?.id ?? ""}
                    projectId={invoice?.project_id ?? undefined}
                    attachments={attachments}
                    onAttach={handleAttach}
                    onDetach={handleDetach}
                    readOnly={attachmentsLoading}
                    compact
                  />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="lien-waivers">
                <AccordionTrigger>
                  <span className="flex items-center gap-2">
                    Lien waivers
                    {(lienWaivers ?? []).length > 0 && (
                      <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
                        {(lienWaivers ?? []).length}
                      </Badge>
                    )}
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3">
                    {(lienWaivers ?? []).length > 0 && (
                      <div className="space-y-2">
                        {(lienWaivers ?? []).map((waiver) => (
                          <div key={waiver.id} className="rounded-md border px-3 py-2 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <span className="min-w-0 truncate font-medium">
                                {INVOICE_WAIVER_TYPE_LABELS[waiver.waiver_type] ?? waiver.waiver_type}
                              </span>
                              <Badge
                                variant="outline"
                                className={
                                  waiver.status === "released"
                                    ? "shrink-0 border-success/30 bg-success/10 text-success"
                                    : "shrink-0 border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
                                }
                              >
                                {waiver.status === "released" ? "Released" : "Pending payment"}
                              </Badge>
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                              <span>
                                {formatMoneyFromCents(waiver.amount_cents)}
                                {waiver.through_date ? ` · through ${format(new Date(waiver.through_date), "MMM d, yyyy")}` : ""}
                              </span>
                              <span className="flex shrink-0 items-center gap-2">
                                {link && (
                                  <a
                                    href={`${link}/waiver/${waiver.id}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline underline-offset-2 hover:text-foreground"
                                  >
                                    View PDF
                                  </a>
                                )}
                                {waiver.status === "pending_payment" && (
                                  <button
                                    type="button"
                                    className="text-destructive underline underline-offset-2 disabled:opacity-50"
                                    disabled={voidingWaiverId === waiver.id}
                                    onClick={() => handleVoidWaiver(waiver.id)}
                                  >
                                    {voidingWaiverId === waiver.id ? "Voiding…" : "Void"}
                                  </button>
                                )}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="space-y-2">
                      <div className="grid grid-cols-[1fr_auto] gap-2">
                        <Select value={waiverType} onValueChange={(value) => setWaiverType(value as InvoiceLienWaiverType)}>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {INVOICE_WAIVER_TYPES.map((type) => (
                              <SelectItem
                                key={type}
                                value={type}
                                disabled={(lienWaivers ?? []).some((w) => w.waiver_type === type)}
                              >
                                {INVOICE_WAIVER_TYPE_LABELS[type]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={
                            creatingWaiver ||
                            !invoice?.id ||
                            invoice?.status === "void" ||
                            (lienWaivers ?? []).some((w) => w.waiver_type === waiverType)
                          }
                          onClick={handleCreateWaiver}
                        >
                          {creatingWaiver ? "Attaching…" : "Attach"}
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Conditional waivers are visible to the client immediately and release automatically when the invoice is
                        paid in full. Unconditional waivers become available only after payment.
                      </p>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="internal-notes">
                <AccordionTrigger>Internal notes</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Add internal notes for your team"
                      value={notesDraft}
                      onChange={(event) => setNotesDraft(event.target.value)}
                      className="min-h-[120px]"
                    />
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">Clients will not see these notes.</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={handleSaveNotes}
                        disabled={savingNotes || (notesDraft === (invoice?.notes ?? ""))}
                      >
                        {savingNotes ? "Saving…" : "Save notes"}
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="activity">
                <AccordionTrigger>Activity</AccordionTrigger>
                <AccordionContent>
                  <div className="space-y-3 text-sm">
                    {timeline.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
                    {timeline.map((entry) => (
                      <div key={entry.id} className="flex items-start justify-between gap-3 border-b pb-2 last:border-b-0 last:pb-0">
                        <div className="min-w-0">
                          <span
                            className={
                              entry.tone === "positive"
                                ? "font-medium text-success"
                                : entry.tone === "destructive"
                                  ? "font-medium text-destructive"
                                  : "font-medium"
                            }
                          >
                            {entry.label}
                          </span>
                          {entry.detail && <p className="mt-0.5 truncate text-xs text-muted-foreground">{entry.detail}</p>}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {format(new Date(entry.at), "MMM d, yyyy, h:mm a")}
                        </span>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}
        </div>
        <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record payment</DialogTitle>
              <DialogDescription>
                Add a manual payment for {invoice?.invoice_number ?? "this invoice"}. This updates the Arc balance and queues the payment for QuickBooks sync.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="invoice-payment-amount">Amount</label>
                <Input
                  id="invoice-payment-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={paymentAmount}
                  onChange={(event) => setPaymentAmount(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="invoice-payment-date">Payment date</label>
                <Input
                  id="invoice-payment-date"
                  type="date"
                  max={format(new Date(), "yyyy-MM-dd")}
                  value={paymentDate}
                  onChange={(event) => setPaymentDate(event.target.value)}
                />
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
                <label className="text-sm font-medium" htmlFor="invoice-payment-reference">Reference</label>
                <Input
                  id="invoice-payment-reference"
                  value={paymentReference}
                  onChange={(event) => setPaymentReference(event.target.value)}
                  placeholder="Check number, note, or QBO payment ref"
                />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPaymentDialogOpen(false)} disabled={recordingPayment}>
                Cancel
              </Button>
              <Button type="button" onClick={handleRecordPayment} disabled={recordingPayment}>
                {recordingPayment ? "Recording..." : "Record payment"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  )
}
