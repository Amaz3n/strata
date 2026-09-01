"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { format } from "date-fns"
import { toast } from "sonner"
import { AlertTriangle, ArrowLeft, ChevronRight, Copy, Download, ExternalLink, Loader2, MinusCircle } from "lucide-react"

import type {
  Invoice,
  InvoiceDelivery,
  InvoiceLienWaiver,
  InvoiceLienWaiverType,
  InvoiceView,
  Payment,
  PaymentReversal,
  ReceivableAdjustment,
} from "@/lib/types"
import { INVOICE_WAIVER_TYPES, INVOICE_WAIVER_TYPE_LABELS } from "@/lib/types"
import type { EntityAuditEntry } from "@/lib/services/audit"
import {
  createInvoiceLienWaiverAction,
  generateInvoicePdfAction,
  getInvoiceDetailAction,
  issueInvoiceAction,
  requestInvoiceApprovalAction,
  sendInvoiceReminderAction,
  updateInvoiceNotesAction,
  voidInvoiceLienWaiverAction,
  voidReceivableAdjustmentAction,
} from "@/app/(app)/invoices/actions"
import { recordPaymentAction } from "@/app/(app)/payments/actions"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"
import { unwrapAction } from "@/lib/action-result"
import { copyText } from "@/lib/clipboard"
import { projectBillingHref, resumeInvoiceHref } from "@/lib/financials/invoice-destinations"
import { qboTxnUrl } from "@/lib/integrations/accounting/qbo/links"
import { cn } from "@/lib/utils"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { DEFAULT_ACCOUNTING_PROVIDER_LABEL } from "@/components/accounting/provider-label"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { useProductTerminology } from "@/components/layout/use-product-terminology"
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
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { MoreHorizontal } from "@/components/icons"

import { ArcInvoiceDocument, toArcInvoiceData, toArcInvoiceLines } from "./arc-invoice-document"
import { ReceivableAdjustmentDialog } from "./receivable-adjustment-dialog"
import {
  InvoiceStatusBadge,
  balanceCentsOf,
  customerNameOf,
  displayStatusOf,
  dueStateLabel,
  formatDateOnly,
  formatMoneyFromCents,
  invoiceProvenanceLabel,
  invoiceSourceTypeOf,
  isEditableInvoice,
  normalizeInvoiceStatus,
  overdueDaysOf,
  totalCentsOf,
} from "./invoice-presentation"

type SyncRecord = { id: string; status: string; last_synced_at: string; error_message?: string | null; qbo_id?: string | null }
type BooksEntry = {
  id: string
  entry_date: string
  status: string
  posting_key: string
  posted_at?: string | null
  reversal_of_entry_id?: string | null
}

export interface InvoiceDetailBundle {
  invoice: Invoice
  link?: string
  views?: InvoiceView[]
  deliveries?: InvoiceDelivery[]
  booksEntries?: BooksEntry[]
  syncHistory?: SyncRecord[]
  payments?: Payment[]
  reversals?: PaymentReversal[]
  adjustments?: ReceivableAdjustment[]
  lienWaivers?: InvoiceLienWaiver[]
  auditTrail?: EntityAuditEntry[]
  /** Sections that failed to load. Named, never silently rendered as empty. */
  loadErrors?: string[]
}

type InspectorSection = "summary" | "activity" | "document" | "accounting"

interface InvoiceInspectorProps {
  detail: InvoiceDetailBundle | null
  projectId?: string | null
  projectName?: string | null
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  loading?: boolean
  /** Rendered on mobile / in a sheet so there is a way back to the list. */
  onBack?: () => void
  onChanged: () => void | Promise<void>
  onDuplicate?: (invoice: Invoice) => void
  onRevise?: (invoice: Invoice) => void
  onVoid?: (invoice: Invoice) => void
  onMakeRecurring?: (invoice: Invoice) => void
  onMove?: (invoice: Invoice) => void
  onResync?: (invoice: Invoice) => Promise<void>
  /** Open the payment dialog as soon as this invoice's detail is on screen. */
  autoOpenPayment?: boolean
  onAutoPaymentHandled?: () => void
}

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
  return [device, browser].filter(Boolean).join(" · ") || null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="microlabel shrink-0">{label}</span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="microlabel">{children}</h3>
}

async function openPdfUrl(url: string, fileName?: string) {
  const link = document.createElement("a")
  link.href = url
  link.target = "_blank"
  link.rel = "noreferrer"
  if (fileName) link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
}

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

export function InvoiceInspectorEmpty({ message }: { message?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <p className="text-sm font-medium text-foreground">No invoice selected</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {message ?? "Pick a row to see its balance, its delivery and payment history, and what has to happen next."}
      </p>
    </div>
  )
}

export function InvoiceInspectorSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-3 border-b px-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="ml-auto h-8 w-28" />
      </div>
      <div className="space-y-6 p-4">
        <div className="space-y-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="space-y-2 border p-4">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  )
}

export function InvoiceInspector(props: InvoiceInspectorProps) {
  const invoice = props.detail?.invoice ?? null
  if (props.loading && !invoice) return <InvoiceInspectorSkeleton />
  if (!invoice || !props.detail) return <InvoiceInspectorEmpty />

  // Keyed on the invoice: switching rows starts a clean inspector rather than
  // carrying a half-typed note, an open payment dialog, or the previous
  // invoice's attachments across to a different balance.
  return <InvoiceInspectorBody key={invoice.id} {...props} detail={props.detail} invoice={invoice} />
}

interface BodyProps extends Omit<InvoiceInspectorProps, "detail" | "loading"> {
  detail: InvoiceDetailBundle
  invoice: Invoice
}

function InvoiceInspectorBody({
  detail,
  invoice,
  projectId,
  projectName,
  builderInfo,
  onBack,
  onChanged,
  onDuplicate,
  onRevise,
  onVoid,
  onMakeRecurring,
  onMove,
  onResync,
  autoOpenPayment,
  onAutoPaymentHandled,
}: BodyProps) {
  const terms = useProductTerminology()
  const [section, setSection] = useState<InspectorSection>("summary")
  const [busy, setBusy] = useState<string | null>(null)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [notesDraft, setNotesDraft] = useState(invoice.notes ?? "")
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(true)
  const [waiverType, setWaiverType] = useState<InvoiceLienWaiverType>("conditional_progress")
  const [voidingWaiverId, setVoidingWaiverId] = useState<string | null>(null)
  const [voidingAdjustmentId, setVoidingAdjustmentId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setAttachmentsLoading(true)
    listAttachmentsAction("invoice", invoice.id)
      .then((links) => {
        if (!cancelled) setAttachments(mapAttachmentLinks(links))
      })
      .catch((error) => console.error("Failed to load invoice attachments", error))
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [invoice.id])

  // The queue's "Record payment" row action selects the invoice AND asks for the
  // dialog, so the button does what it says instead of merely navigating near it.
  useEffect(() => {
    if (!autoOpenPayment) return
    setPaymentOpen(true)
    onAutoPaymentHandled?.()
  }, [autoOpenPayment, onAutoPaymentHandled])
  const resolvedProjectId = projectId ?? invoice.project_id ?? null
  const status = displayStatusOf(invoice)
  const balance = balanceCentsOf(invoice)
  const total = totalCentsOf(invoice)
  const editable = isEditableInvoice(invoice)
  const wasIssued = Boolean(invoice.sent_at) || ["sent", "partial", "overdue", "paid"].includes(status)
  const link = detail.link
  const loadErrors = detail.loadErrors ?? []
  const failed = (label: string) => loadErrors.includes(label)

  const reversedByPayment = useMemo(() => {
    const map = new Map<string, number>()
    for (const reversal of detail.reversals ?? []) {
      if (reversal.status === "failed") continue
      map.set(reversal.payment_id, (map.get(reversal.payment_id) ?? 0) + reversal.amount_cents)
    }
    return map
  }, [detail.reversals])

  const appliedPayments = useMemo(() => (detail.payments ?? []).filter((p) => p.status === "succeeded"), [detail.payments])
  const processingPayments = useMemo(
    () => (detail.payments ?? []).filter((p) => p.status === "processing"),
    [detail.payments],
  )
  const postedAdjustments = useMemo(
    () => (detail.adjustments ?? []).filter((adjustment) => adjustment.status === "posted"),
    [detail.adjustments],
  )
  const collectedCents = useMemo(
    () =>
      Math.max(
        0,
        appliedPayments.reduce(
          (sum, payment) => sum + Math.max(0, payment.amount_cents - (reversedByPayment.get(payment.id) ?? 0)),
          0,
        ),
      ),
    [appliedPayments, reversedByPayment],
  )
  const adjustedCents = postedAdjustments.reduce((sum, adjustment) => sum + adjustment.amount_cents, 0)

  const activity = useMemo(() => {
    const entries: Array<{ id: string; at: string; label: string; detail: string | null; tone: string }> = []
    for (const delivery of detail.deliveries ?? []) {
      const at = delivery.delivered_at ?? delivery.sent_at ?? delivery.failed_at ?? delivery.queued_at
      if (!at) continue
      entries.push({
        id: `delivery:${delivery.id}`,
        at,
        label:
          delivery.metadata?.kind === "payment_reminder"
            ? delivery.status === "failed"
              ? "Reminder failed"
              : "Payment reminder sent"
            : delivery.status === "failed"
              ? "Invoice delivery failed"
              : `Invoice ${delivery.status}`,
        detail: delivery.error_message ?? delivery.recipient ?? null,
        tone: delivery.status === "failed" || delivery.status === "bounced" ? "destructive" : "default",
      })
    }
    for (const view of detail.views ?? []) {
      if (!view.viewed_at) continue
      entries.push({
        id: `view:${view.id}`,
        at: view.viewed_at,
        label: "Invoice viewed",
        detail: describeUserAgent(view.user_agent),
        tone: "default",
      })
    }
    for (const payment of detail.payments ?? []) {
      if (!payment.received_at) continue
      entries.push({
        id: `payment:${payment.id}`,
        at: payment.received_at,
        label:
          payment.status === "succeeded"
            ? `Payment received · ${formatMoneyFromCents(payment.amount_cents)}`
            : payment.status === "processing"
              ? `Payment processing · ${formatMoneyFromCents(payment.amount_cents)}`
              : `Payment ${payment.status}`,
        detail: payment.reference ?? payment.method ?? null,
        tone: payment.status === "succeeded" ? "positive" : payment.status === "failed" ? "destructive" : "default",
      })
    }
    for (const reversal of detail.reversals ?? []) {
      if (reversal.status === "failed") continue
      const at = reversal.occurred_at ?? reversal.created_at
      if (!at) continue
      entries.push({
        id: `reversal:${reversal.id}`,
        at,
        label: `Payment ${reversal.reversal_type.replaceAll("_", " ")} · −${formatMoneyFromCents(reversal.amount_cents)}`,
        detail: reversal.reason ?? null,
        tone: "destructive",
      })
    }
    for (const adjustment of detail.adjustments ?? []) {
      const at = adjustment.voided_at ?? adjustment.created_at
      if (!at) continue
      entries.push({
        id: `adjustment:${adjustment.id}`,
        at,
        label: `${adjustment.adjustment_type === "write_off" ? "Write-off" : "Credit memo"}${
          adjustment.status === "void" ? " voided" : " posted"
        } · −${formatMoneyFromCents(adjustment.amount_cents)}`,
        detail: adjustment.reason,
        tone: adjustment.status === "void" ? "default" : "destructive",
      })
    }
    return entries.sort((left, right) => String(right.at).localeCompare(String(left.at)))
  }, [detail.adjustments, detail.deliveries, detail.payments, detail.reversals, detail.views])

  async function withBusy(key: string, fn: () => Promise<void>) {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  const handleIssue = () =>
    withBusy("issue", async () => {
      try {
        unwrapAction(await issueInvoiceAction(invoice.id))
        toast.success("Invoice issued", { description: "The customer has been emailed a copy." })
        await onChanged()
      } catch (error) {
        toast.error("Could not issue invoice", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleRequestApproval = () =>
    withBusy("approval", async () => {
      try {
        unwrapAction(await requestInvoiceApprovalAction(invoice.id))
        toast.success("Sent for approval")
        await onChanged()
      } catch (error) {
        toast.error("Could not request approval", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleReminder = () =>
    withBusy("reminder", async () => {
      try {
        unwrapAction(await sendInvoiceReminderAction(invoice.id))
        toast.success("Reminder sent")
        await onChanged()
      } catch (error) {
        toast.error("Could not send reminder", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleDownloadPdf = () =>
    withBusy("pdf", async () => {
      try {
        const result = unwrapAction(await generateInvoicePdfAction(invoice.id, { persistToArc: true }))
        if (result.downloadUrl && typeof window !== "undefined") await openPdfUrl(result.downloadUrl, result.fileName)
        toast.success("Invoice PDF saved to Arc")
      } catch (error) {
        toast.error("Could not generate the PDF", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleCopyLink = async () => {
    if (!link) return
    const copied = await copyText(link)
    toast.success(copied ? "Link copied" : "Link ready", { description: link })
  }

  const handleSaveNotes = () =>
    withBusy("notes", async () => {
      try {
        unwrapAction(await updateInvoiceNotesAction(invoice.id, notesDraft))
        toast.success("Notes saved")
        await onChanged()
      } catch (error) {
        toast.error("Could not save notes", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  const handleAttach = async (files: File[], linkRole?: string) => {
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      if (invoice.project_id) formData.append("projectId", invoice.project_id)
      formData.append("category", "financials")
      const uploaded = unwrapAction(await uploadFileAction(formData))
      unwrapAction(await attachFileAction(uploaded.id, "invoice", invoice.id, invoice.project_id ?? undefined, linkRole))
    }
    setAttachments(mapAttachmentLinks(await listAttachmentsAction("invoice", invoice.id)))
  }

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId))
    setAttachments(mapAttachmentLinks(await listAttachmentsAction("invoice", invoice.id)))
  }

  const handleCreateWaiver = () =>
    withBusy("waiver", async () => {
      try {
        unwrapAction(await createInvoiceLienWaiverAction({ invoiceId: invoice.id, waiverType }))
        toast.success("Lien waiver attached")
        await onChanged()
      } catch (error) {
        toast.error("Could not attach the waiver", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  async function handleVoidWaiver(waiverId: string) {
    setVoidingWaiverId(waiverId)
    try {
      unwrapAction(await voidInvoiceLienWaiverAction(waiverId))
      toast.success("Lien waiver voided")
      await onChanged()
    } catch (error) {
      toast.error("Could not void the waiver", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setVoidingWaiverId(null)
    }
  }

  async function handleVoidAdjustment(adjustment: ReceivableAdjustment) {
    setVoidingAdjustmentId(adjustment.id)
    try {
      unwrapAction(await voidReceivableAdjustmentAction(adjustment.id))
      toast.success("Adjustment voided", { description: "The invoice balance has reopened." })
      await onChanged()
    } catch (error) {
      toast.error("Could not void the adjustment", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setVoidingAdjustmentId(null)
    }
  }

  // One primary action per invoice, chosen by what the invoice actually needs.
  const primary = (() => {
    if (status === "void") return null
    if (editable) {
      if (invoice.approval_status === "draft") {
        return { label: "Send for approval", onClick: handleRequestApproval, key: "approval" }
      }
      if (invoice.approval_status === "pending") return null
      return { label: "Issue invoice", onClick: handleIssue, key: "issue" }
    }
    if (status === "draft" && invoice.approval_status === "approved") {
      return { label: "Issue invoice", onClick: handleIssue, key: "issue" }
    }
    if (invoice.delivery_status === "failed" || invoice.delivery_status === "bounced") {
      return { label: "Resend invoice", onClick: handleReminder, key: "reminder" }
    }
    if (status === "overdue") return { label: "Send reminder", onClick: handleReminder, key: "reminder" }
    if (balance > 0 && wasIssued) return { label: "Record payment", onClick: () => setPaymentOpen(true), key: "payment" }
    return null
  })()

  const canRecordPayment = wasIssued && balance > 0 && status !== "void"
  const canAdjust = Boolean(wasIssued && balance > 0 && status !== "void" && (invoice.metadata as any)?.invoice_kind !== "earnest_deposit")

  const provenanceHref = (() => {
    if (!resolvedProjectId) return null
    switch (invoiceSourceTypeOf(invoice)) {
      case "draw":
        return projectBillingHref(resolvedProjectId, "draws")
      case "pay_application":
        return projectBillingHref(resolvedProjectId, "payapps")
      case "change_order":
        return `/projects/${resolvedProjectId}/change-orders`
      case "fee":
        return projectBillingHref(resolvedProjectId, "fee")
      case "from_costs":
        return projectBillingHref(resolvedProjectId, "close")
      default:
        return null
    }
  })()

  const sections: Array<{ key: InspectorSection; label: string }> = [
    { key: "summary", label: "Summary" },
    { key: "activity", label: "Activity" },
    { key: "document", label: "Document" },
    { key: "accounting", label: "Accounting" },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header: identity, state, and the one thing to do next. */}
      <div className="shrink-0 border-b">
        <div className="flex items-start gap-2 px-4 pt-4">
          {onBack ? (
            <Button variant="ghost" size="icon" className="-ml-2 h-8 w-8 shrink-0" onClick={onBack} title="Back to list">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-base font-semibold leading-tight">
                {invoice.invoice_number || invoice.title || "Untitled invoice"}
              </h2>
              <InvoiceStatusBadge invoice={invoice} />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {customerNameOf(invoice) || `No ${terms.owner.toLowerCase()} on this invoice`}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Invoice actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onSelect={() => void handleDownloadPdf()} disabled={busy === "pdf"}>
                <Download className="mr-2 h-4 w-4" />
                Download PDF
              </DropdownMenuItem>
              {wasIssued && link ? (
                <DropdownMenuItem onSelect={() => void handleCopyLink()}>
                  <Copy className="mr-2 h-4 w-4" />
                  Copy customer link
                </DropdownMenuItem>
              ) : null}
              {canRecordPayment && primary?.key !== "payment" ? (
                <DropdownMenuItem onSelect={() => setPaymentOpen(true)}>Record payment</DropdownMenuItem>
              ) : null}
              {canAdjust ? (
                <DropdownMenuItem onSelect={() => setAdjusting(true)}>
                  <MinusCircle className="mr-2 h-4 w-4" />
                  Credit or write off
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              {onDuplicate ? <DropdownMenuItem onSelect={() => onDuplicate(invoice)}>Duplicate</DropdownMenuItem> : null}
              {onMakeRecurring ? (
                <DropdownMenuItem onSelect={() => onMakeRecurring(invoice)} disabled={status === "void"}>
                  Make recurring…
                </DropdownMenuItem>
              ) : null}
              {onRevise ? (
                <DropdownMenuItem
                  onSelect={() => onRevise(invoice)}
                  disabled={!["sent", "overdue"].includes(status)}
                >
                  Revise and reissue
                </DropdownMenuItem>
              ) : null}
              {onMove ? (
                <DropdownMenuItem onSelect={() => onMove(invoice)} disabled={!editable}>
                  Move to project…
                </DropdownMenuItem>
              ) : null}
              {onVoid ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => onVoid(invoice)}
                    disabled={["paid", "partial", "void"].includes(status)}
                    className="text-destructive focus:text-destructive"
                  >
                    Void invoice
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-end justify-between gap-4 px-4 pt-3">
          <div>
            <div className="microlabel">{balance > 0 ? "Balance due" : "Invoice total"}</div>
            <div
              className={cn(
                "font-mono text-2xl font-semibold tabular-nums",
                status === "overdue" && "text-destructive",
                status === "paid" && "text-success",
              )}
            >
              {formatMoneyFromCents(balance > 0 ? balance : total)}
            </div>
            <p className={cn("mt-0.5 text-xs", overdueDaysOf(invoice) > 0 ? "text-destructive" : "text-muted-foreground")}>
              {dueStateLabel(invoice)}
            </p>
          </div>
          {primary ? (
            <Button size="sm" className="mb-1 shrink-0" onClick={() => void primary.onClick()} disabled={busy === primary.key}>
              {busy === primary.key ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
              {primary.label}
            </Button>
          ) : editable ? null : null}
        </div>

        {editable && resolvedProjectId ? (
          <div className="px-4 pt-3">
            <Button variant="outline" size="sm" className="w-full" asChild>
              <Link href={resumeInvoiceHref(resolvedProjectId, invoice.id)}>Continue editing this draft</Link>
            </Button>
          </div>
        ) : null}

        {invoice.approval_status === "pending" ? (
          <p className="mx-4 mt-3 border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
            Waiting on an approver. It can be issued once someone with approval rights signs off.
          </p>
        ) : null}

        {loadErrors.length > 0 ? (
          <p className="mx-4 mt-3 flex items-start gap-2 border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              Some of this invoice could not be loaded ({loadErrors.join(", ")}). What you see below is incomplete —
              reload before drawing conclusions from it.
            </span>
          </p>
        ) : null}

        <nav className="mt-3 flex items-center gap-1 px-2" aria-label="Invoice sections">
          {sections.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setSection(entry.key)}
              aria-current={section === entry.key ? "page" : undefined}
              className={cn(
                "border-b-2 px-2.5 py-2 text-xs font-medium transition-colors",
                section === entry.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "summary" ? (
          <div className="space-y-6 p-4">
            <section className="space-y-1 border bg-card p-4">
              <Row label="Total">
                <span className="font-mono tabular-nums">{formatMoneyFromCents(total)}</span>
              </Row>
              <Row label="Collected">
                <span className={cn("font-mono tabular-nums", collectedCents > 0 && "text-success")}>
                  {failed("payments") ? "—" : formatMoneyFromCents(collectedCents)}
                </span>
              </Row>
              {adjustedCents > 0 ? (
                <Row label="Credited">
                  <span className="font-mono tabular-nums">−{formatMoneyFromCents(adjustedCents)}</span>
                </Row>
              ) : null}
              <Row label="Balance">
                <span className={cn("font-mono tabular-nums", balance > 0 ? "font-semibold" : "text-muted-foreground")}>
                  {formatMoneyFromCents(balance)}
                </span>
              </Row>
              <div className="mt-3 border-t pt-3">
                <Row label="Issued">{invoice.sent_at ? format(new Date(invoice.sent_at), "MMM d, yyyy") : "Not yet"}</Row>
                <Row label="Due">{formatDateOnly(invoice.due_date, { withYear: true })}</Row>
                <Row label="Source">
                  {provenanceHref ? (
                    <Link href={provenanceHref} className="inline-flex items-center gap-1 text-primary hover:underline">
                      {invoiceProvenanceLabel(invoice)}
                      <ChevronRight className="h-3 w-3" />
                    </Link>
                  ) : (
                    invoiceProvenanceLabel(invoice)
                  )}
                </Row>
              </div>
            </section>

            {postedAdjustments.length > 0 ? (
              <section className="space-y-2">
                <SectionHeading>Credits &amp; write-offs</SectionHeading>
                <div className="divide-y border bg-card">
                  {postedAdjustments.map((adjustment) => (
                    <div key={adjustment.id} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className="font-medium text-foreground">
                          {adjustment.adjustment_type === "write_off" ? "Write-off" : "Credit memo"} ·{" "}
                          {formatMoneyFromCents(adjustment.amount_cents)}
                        </p>
                        <p className="truncate text-muted-foreground">{adjustment.reason}</p>
                      </div>
                      <button
                        type="button"
                        className="shrink-0 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                        disabled={voidingAdjustmentId === adjustment.id}
                        onClick={() => void handleVoidAdjustment(adjustment)}
                      >
                        {voidingAdjustmentId === adjustment.id ? "Voiding…" : "Void"}
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="space-y-2">
              <SectionHeading>Backup &amp; attachments</SectionHeading>
              <div className="border bg-card p-3">
                <EntityAttachments
                  entityType="invoice"
                  entityId={invoice.id}
                  projectId={invoice.project_id ?? undefined}
                  attachments={attachments}
                  onAttach={handleAttach}
                  onDetach={handleDetach}
                  readOnly={attachmentsLoading}
                  compact
                />
              </div>
            </section>

            <section className="space-y-2">
              <SectionHeading>Lien waivers</SectionHeading>
              {failed("lien waivers") ? (
                <p className="border bg-card p-3 text-xs text-warning">Lien waivers could not be loaded.</p>
              ) : (
                <div className="space-y-2">
                  {(detail.lienWaivers ?? []).length > 0 ? (
                    <div className="divide-y border bg-card">
                      {(detail.lienWaivers ?? []).map((waiver) => (
                        <div key={waiver.id} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                          <span className="min-w-0 truncate font-medium">
                            {INVOICE_WAIVER_TYPE_LABELS[waiver.waiver_type] ?? waiver.waiver_type}
                          </span>
                          <span className="flex shrink-0 items-center gap-3">
                            <span className={waiver.status === "released" ? "text-success" : "text-warning"}>
                              {waiver.status === "released" ? "Released" : "Pending payment"}
                            </span>
                            {link ? (
                              <a
                                href={`${link}/waiver/${waiver.id}`}
                                target="_blank"
                                rel="noreferrer"
                                className="underline underline-offset-2 hover:text-foreground"
                              >
                                PDF
                              </a>
                            ) : null}
                            {waiver.status === "pending_payment" ? (
                              <button
                                type="button"
                                className="text-destructive underline underline-offset-2 disabled:opacity-50"
                                disabled={voidingWaiverId === waiver.id}
                                onClick={() => void handleVoidWaiver(waiver.id)}
                              >
                                {voidingWaiverId === waiver.id ? "Voiding…" : "Void"}
                              </button>
                            ) : null}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="border border-dashed bg-card p-3 text-xs text-muted-foreground">
                      No lien waivers attached.
                    </p>
                  )}
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <Select value={waiverType} onValueChange={(value) => setWaiverType(value as InvoiceLienWaiverType)}>
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {INVOICE_WAIVER_TYPES.map((type) => (
                          <SelectItem
                            key={type}
                            value={type}
                            disabled={(detail.lienWaivers ?? []).some((w) => w.waiver_type === type)}
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
                        busy === "waiver" ||
                        status === "void" ||
                        (detail.lienWaivers ?? []).some((w) => w.waiver_type === waiverType)
                      }
                      onClick={() => void handleCreateWaiver()}
                    >
                      {busy === "waiver" ? "Attaching…" : "Attach"}
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <section className="space-y-2">
              <SectionHeading>Internal notes</SectionHeading>
              <Textarea
                placeholder="Notes for your team about this invoice"
                value={notesDraft}
                onChange={(event) => setNotesDraft(event.target.value)}
                className="min-h-24"
              />
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">{terms.owners} never see these.</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleSaveNotes()}
                  disabled={busy === "notes" || notesDraft === (invoice.notes ?? "")}
                >
                  {busy === "notes" ? "Saving…" : "Save notes"}
                </Button>
              </div>
            </section>
          </div>
        ) : null}

        {section === "activity" ? (
          <div className="space-y-6 p-4">
            <section className="space-y-2">
              <SectionHeading>Payments</SectionHeading>
              {failed("payments") ? (
                <p className="border border-warning/30 bg-warning/10 p-3 text-xs">
                  Payment history could not be loaded. This invoice may have payments that are not shown.
                </p>
              ) : appliedPayments.length === 0 && processingPayments.length === 0 ? (
                <p className="border border-dashed bg-card p-3 text-xs text-muted-foreground">Nothing collected yet.</p>
              ) : (
                <div className="divide-y border bg-card">
                  {appliedPayments.map((payment) => {
                    const reversed = reversedByPayment.get(payment.id) ?? 0
                    return (
                      <div key={payment.id} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                        <span className="min-w-0 truncate text-xs text-muted-foreground">
                          {payment.received_at ? format(new Date(payment.received_at), "MMM d, yyyy") : "No date"}
                          {payment.reference ? ` · ${payment.reference}` : ""}
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-mono font-medium tabular-nums text-success">
                            {formatMoneyFromCents(Math.max(0, payment.amount_cents - reversed))}
                          </span>
                          {reversed > 0 ? (
                            <span className="block text-[10px] text-destructive">
                              Reversed {formatMoneyFromCents(reversed)}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    )
                  })}
                  {processingPayments.map((payment) => (
                    <div key={payment.id} className="flex items-center justify-between gap-4 px-3 py-2.5 text-sm">
                      <span className="truncate text-xs text-muted-foreground">ACH submitted · awaiting settlement</span>
                      <span className="shrink-0 font-mono tabular-nums text-warning">
                        {formatMoneyFromCents(payment.amount_cents)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <SectionHeading>Timeline</SectionHeading>
              {activity.length === 0 ? (
                <p className="border border-dashed bg-card p-3 text-xs text-muted-foreground">
                  {wasIssued ? "Nothing has happened since it went out." : "Not issued yet."}
                </p>
              ) : (
                <div className="space-y-2 border bg-card p-3">
                  {activity.slice(0, 40).map((entry) => (
                    <div
                      key={entry.id}
                      className="flex items-start justify-between gap-3 border-t pt-2 first:border-t-0 first:pt-0"
                    >
                      <div className="min-w-0">
                        <p
                          className={cn(
                            "truncate text-xs font-medium",
                            entry.tone === "positive" && "text-success",
                            entry.tone === "destructive" && "text-destructive",
                          )}
                        >
                          {entry.label}
                        </p>
                        {entry.detail ? (
                          <p className="truncate text-[11px] text-muted-foreground">{entry.detail}</p>
                        ) : null}
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {format(new Date(entry.at), "MMM d, h:mm a")}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {(detail.auditTrail ?? []).length > 0 ? (
              <section className="space-y-2">
                <SectionHeading>Change history</SectionHeading>
                <div className="divide-y border bg-card">
                  {(detail.auditTrail ?? []).slice(0, 25).map((entry) => {
                    const changedKeys =
                      entry.action === "update"
                        ? Object.keys(entry.after ?? {}).filter(
                            (key) => (entry.before ?? {})[key] !== (entry.after ?? {})[key],
                          )
                        : []
                    return (
                      <div key={entry.id} className="space-y-0.5 px-3 py-2 text-xs">
                        <div className="flex items-start justify-between gap-3">
                          <span className="font-medium text-foreground">
                            {entry.action === "insert" ? "Created" : entry.action === "delete" ? "Deleted" : "Updated"}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {format(new Date(entry.createdAt), "MMM d, h:mm a")}
                          </span>
                        </div>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {entry.actor?.name ?? "System"}
                          {changedKeys.length > 0
                            ? ` · ${changedKeys.slice(0, 4).join(", ")}${changedKeys.length > 4 ? "…" : ""}`
                            : entry.source
                              ? ` · ${entry.source}`
                              : ""}
                        </p>
                      </div>
                    )
                  })}
                </div>
              </section>
            ) : null}
          </div>
        ) : null}

        {section === "document" ? (
          <InvoiceDocumentPreview
            invoice={invoice}
            builderInfo={builderInfo}
            projectName={projectName}
            link={link}
            onDownload={() => void handleDownloadPdf()}
            downloading={busy === "pdf"}
          />
        ) : null}

        {section === "accounting" ? (
          <div className="space-y-6 p-4">
            <section className="space-y-2">
              <SectionHeading>Sync status</SectionHeading>
              <div className="space-y-2 border bg-card p-3">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <AccountingSyncBadge
                    status={invoice.qbo_sync_status}
                    externalId={invoice.qbo_id ?? undefined}
                    syncedAt={invoice.qbo_synced_at ?? undefined}
                  />
                  <div className="flex items-center gap-3">
                    {invoice.qbo_id ? (
                      <a
                        href={qboTxnUrl("invoice", invoice.qbo_id) ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Open in {DEFAULT_ACCOUNTING_PROVIDER_LABEL}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                    {onResync ? (
                      <button
                        type="button"
                        className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                        disabled={busy === "resync"}
                        onClick={() => void withBusy("resync", () => onResync(invoice))}
                      >
                        {busy === "resync" ? "Syncing…" : "Sync now"}
                      </button>
                    ) : null}
                  </div>
                </div>
                {failed("accounting sync history") ? (
                  <p className="text-xs text-warning">Sync history could not be loaded.</p>
                ) : (
                  (detail.syncHistory ?? []).slice(0, 5).map((log) => (
                    <div key={log.id} className="border-t pt-2 text-xs text-muted-foreground">
                      <div className="flex items-center justify-between gap-2">
                        <AccountingSyncBadge status={log.status} error={log.error_message} />
                        <span>{log.last_synced_at ? new Date(log.last_synced_at).toLocaleDateString() : "—"}</span>
                      </div>
                      {log.error_message ? <p className="mt-0.5 text-destructive">{log.error_message}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="space-y-2">
              <SectionHeading>Arc Books</SectionHeading>
              {failed("Books impact") ? (
                <p className="border border-warning/30 bg-warning/10 p-3 text-xs">Books entries could not be loaded.</p>
              ) : (detail.booksEntries ?? []).length > 0 ? (
                <div className="divide-y border bg-card">
                  {(detail.booksEntries ?? []).map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-medium capitalize text-foreground">{entry.status}</p>
                        <p className="truncate text-muted-foreground">
                          {entry.posting_key.includes("receivable_adjustment") ? "AR adjustment" : "AR / contract billing"}{" "}
                          · {entry.entry_date}
                        </p>
                      </div>
                      <Link href={`/books/ledger?entry=${entry.id}`} className="shrink-0 font-medium text-primary hover:underline">
                        View entry
                      </Link>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="border border-dashed bg-card p-3 text-xs text-muted-foreground">
                  {wasIssued ? "Waiting for the next Books projection." : "Nothing posts until the invoice is issued."}
                </p>
              )}
            </section>

            {link ? (
              <section className="space-y-2">
                <SectionHeading>Customer link</SectionHeading>
                <a
                  href={link}
                  target="_blank"
                  rel="noreferrer"
                  className="block truncate border bg-card p-3 text-xs text-primary hover:underline"
                >
                  {link}
                </a>
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <RecordPaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        invoice={invoice}
        balanceCents={balance}
        onRecorded={onChanged}
      />
      <ReceivableAdjustmentDialog
        invoice={invoice}
        open={adjusting}
        onOpenChange={setAdjusting}
        onPosted={async () => {
          await onChanged()
        }}
      />
    </div>
  )
}

function InvoiceDocumentPreview({
  invoice,
  builderInfo,
  projectName,
  link,
  onDownload,
  downloading,
}: {
  invoice: Invoice
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  projectName?: string | null
  link?: string
  onDownload: () => void
  downloading: boolean
}) {
  const measureRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(520)

  useEffect(() => {
    const element = measureRef.current
    if (!element) return
    const update = () => setWidth(Math.max(280, Math.min(820, element.clientWidth - 32)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const data = useMemo(
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
  const lines = useMemo(() => toArcInvoiceLines(invoice), [invoice])

  return (
    <div ref={measureRef} className="min-h-full bg-muted/20 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Exactly what the customer sees.</p>
        <Button variant="outline" size="sm" onClick={onDownload} disabled={downloading}>
          {downloading ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-2 h-3.5 w-3.5" />}
          PDF
        </Button>
      </div>
      <div className="mx-auto w-fit border bg-background shadow-sm">
        <ArcInvoiceDocument data={data} lines={lines} width={width} height={width * 1.294} />
      </div>
    </div>
  )
}

/**
 * Manual receipts get ONE idempotency key per dialog session, minted when the
 * dialog opens and reused by every retry inside it. The previous key was
 * `manual:${invoiceId}:${Date.now()}`, regenerated on each submit — so a request
 * whose response was lost, retried by an impatient person, recorded the money
 * twice.
 */
function RecordPaymentDialog({
  open,
  onOpenChange,
  invoice,
  balanceCents,
  onRecorded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  invoice: Invoice
  balanceCents: number
  onRecorded: () => void | Promise<void>
}) {
  const [amount, setAmount] = useState("")
  const [method, setMethod] = useState<"ach" | "card" | "wire" | "check">("ach")
  const [reference, setReference] = useState("")
  const [receivedOn, setReceivedOn] = useState(format(new Date(), "yyyy-MM-dd"))
  const [saving, setSaving] = useState(false)
  const attemptKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!open) return
    setAmount((balanceCents / 100).toFixed(2))
    setMethod("ach")
    setReference("")
    setReceivedOn(format(new Date(), "yyyy-MM-dd"))
    attemptKeyRef.current = `manual-receipt:${invoice.id}:${crypto.randomUUID()}`
  }, [open, balanceCents, invoice.id])

  async function submit() {
    const amountCents = Math.round(Number(amount) * 100)
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      toast.error("Enter a payment amount")
      return
    }
    if (amountCents > balanceCents) {
      toast.error("That is more than the balance due")
      return
    }
    const receivedAt = receivedOn ? new Date(`${receivedOn}T12:00:00`) : null
    if (!receivedAt || Number.isNaN(receivedAt.getTime())) {
      toast.error("Enter a valid payment date")
      return
    }
    if (receivedAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      toast.error("Payment date cannot be in the future")
      return
    }
    const idempotencyKey = attemptKeyRef.current ?? `manual-receipt:${invoice.id}:${crypto.randomUUID()}`

    setSaving(true)
    try {
      unwrapAction(
        await recordPaymentAction({
          invoice_id: invoice.id,
          provider: "manual",
          provider_payment_id: idempotencyKey,
          idempotency_key: idempotencyKey,
          amount_cents: amountCents,
          currency: "usd",
          method,
          status: "succeeded",
          reference: reference.trim() || undefined,
          received_at: receivedAt.toISOString(),
          metadata: { source: "arc_manual_invoice_payment" },
        }),
      )
      toast.success(amountCents >= balanceCents ? "Invoice marked paid" : "Payment recorded")
      onOpenChange(false)
      await onRecorded()
    } catch (error) {
      toast.error("Could not record the payment", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            Money received outside Arc for {invoice.invoice_number}. This updates the balance and queues the receipt for
            accounting.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="invoice-payment-amount">
              Amount
            </label>
            <Input
              id="invoice-payment-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="invoice-payment-date">
              Received on
            </label>
            <Input
              id="invoice-payment-date"
              type="date"
              max={format(new Date(), "yyyy-MM-dd")}
              value={receivedOn}
              onChange={(event) => setReceivedOn(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Method</label>
            <Select value={method} onValueChange={(value) => setMethod(value as typeof method)}>
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
            <label className="text-sm font-medium" htmlFor="invoice-payment-reference">
              Reference
            </label>
            <Input
              id="invoice-payment-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Check number or note"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={saving}>
            {saving ? "Recording…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { normalizeInvoiceStatus }

/**
 * The inspector inside a Sheet, for surfaces that own a different record and are
 * only glancing at its invoice — a draw, a cost-inbox item.
 *
 * It loads its own detail from the invoice id. That is the whole point of it
 * existing: the old `InvoiceDetailSheet` was a SECOND detail implementation, and
 * every caller had to hand-assemble the pieces it wanted, so the draw schedule
 * showed views and sync history while Cost Inbox showed payments, and neither
 * showed attachments or notes.
 */
export function InvoiceInspectorSheet({
  invoiceId,
  open,
  onOpenChange,
  projectName,
  builderInfo,
  onChanged,
}: {
  invoiceId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  projectName?: string | null
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  onChanged?: () => void | Promise<void>
}) {
  const [detail, setDetail] = useState<InvoiceDetailBundle | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!invoiceId) return
    setLoading(true)
    try {
      setDetail(unwrapAction(await getInvoiceDetailAction(invoiceId)))
    } catch (error) {
      toast.error("Could not load the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
      setDetail(null)
    } finally {
      setLoading(false)
    }
  }, [invoiceId])

  useEffect(() => {
    if (!open || !invoiceId) return
    if (detail?.invoice.id === invoiceId) return
    void load()
  }, [open, invoiceId, detail?.invoice.id, load])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetTitle className="sr-only">Invoice detail</SheetTitle>
        <InvoiceInspector
          detail={detail}
          loading={loading}
          projectName={projectName}
          builderInfo={builderInfo}
          onChanged={async () => {
            await load()
            await onChanged?.()
          }}
        />
      </SheetContent>
    </Sheet>
  )
}
