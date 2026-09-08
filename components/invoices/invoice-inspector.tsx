"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { format } from "date-fns"
import { toast } from "sonner"
import { AlertTriangle, ArrowLeft, ChevronRight, Copy, Download, ExternalLink, Loader2, MinusCircle } from "lucide-react"

import type {
  Invoice,
  InvoiceDelivery,
  InvoiceLienWaiver,
  InvoiceView,
  Payment,
  PaymentReversal,
  ReceivableAdjustment,
} from "@/lib/types"
import type { EntityAuditEntry } from "@/lib/services/audit"
import type { FileLinkWithFile } from "@/lib/services/file-links"
import { receivablesLabels, type ReceivablesAccountingMode } from "@/lib/financials/billing-profile"
import {
  cancelScheduledInvoiceSendAction,
  generateInvoicePdfAction,
  getInvoiceDetailAction,
  issueInvoiceAction,
  requestInvoiceApprovalAction,
  sendInvoiceReminderAction,
  updateInvoiceNotesAction,
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
import type { AttachedFile } from "@/components/files"
import { InvoiceAttachmentsField } from "./invoice-attachments-field"
import { InvoiceWaiverCard } from "./invoice-waiver-card"
import { isInvoiceAttachment } from "@/lib/invoices/attachment-roles"
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
  scheduledSendAtOf,
  formatScheduledSend,
  totalCentsOf,
  type InvoiceLifecycleStatus,
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
  attachments?: FileLinkWithFile[]
  /** Sections that failed to load. Named, never silently rendered as empty. */
  loadErrors?: string[]
}

export type InspectorSection = "summary" | "activity" | "attachments" | "accounting"

interface InvoiceInspectorProps {
  detail: InvoiceDetailBundle | null
  /**
   * The list row for the invoice being opened. Everything the header shows is
   * on it, so the header paints from the row and only the sections wait.
   */
  placeholder?: Invoice | null
  error?: string | null
  onRetry?: () => void
  accounting?: ReceivablesAccountingMode
  projectId?: string | null
  projectName?: string | null
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  loading?: boolean
  /** Rendered on mobile / in a sheet so there is a way back to the list. */
  onBack?: () => void
  onChanged: () => void | Promise<void>
  onDuplicate?: (invoice: Invoice) => void
  /** Open the draft in the composer in place; without it the Edit button navigates. */
  onEdit?: (invoice: Invoice) => void
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
  return links.filter(isInvoiceAttachment).map((link) => ({
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

/**
 * The header from the row, the body still loading. A number that is already
 * on screen in the table should never turn into a grey bar on the way over.
 */
function InvoiceInspectorPlaceholder({ invoice, onBack }: { invoice: Invoice; onBack?: () => void }) {
  const status = displayStatusOf(invoice)
  const balance = balanceCentsOf(invoice)
  const total = totalCentsOf(invoice)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" aria-busy="true">
      <div className="shrink-0 border-b">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          {onBack ? (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onBack} title="Back to list">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h2 className="truncate text-sm font-semibold leading-tight">
              {invoice.invoice_number || invoice.title || "Untitled invoice"}
            </h2>
            {status !== "overdue" ? <InvoiceStatusBadge invoice={invoice} /> : null}
          </div>
          <Skeleton className="h-8 w-8" />
        </div>
        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
          <p className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "font-mono text-xl font-semibold tabular-nums",
                status === "overdue" && "text-destructive",
                status === "paid" && "text-success",
              )}
            >
              {formatMoneyFromCents(balance > 0 ? balance : total)}
            </span>
            <span className={cn("truncate text-xs", overdueDaysOf(invoice) > 0 ? "text-destructive" : "text-muted-foreground")}>
              {dueStateLabel(invoice)}
            </span>
          </p>
          <Skeleton className="h-8 w-28" />
        </div>
        <div className="flex items-center gap-1 px-2">
          {["Summary", "Activity", "Attachments", "Accounting"].map((label) => (
            <span key={label} className="px-2.5 py-2 text-xs font-medium text-muted-foreground/60">
              {label}
            </span>
          ))}
        </div>
      </div>
      <div className="space-y-6 p-4">
        <div className="space-y-2 border p-4">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center justify-between gap-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-24" />
            </div>
          ))}
        </div>
        <Skeleton className="h-24 w-full" />
      </div>
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
  if (props.error && !invoice) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <p className="text-sm font-medium">This invoice could not be loaded.</p>
        <p className="max-w-xs text-xs text-muted-foreground">{props.error}</p>
        <div className="flex items-center gap-2">
          {props.onBack ? (
            <Button variant="outline" size="sm" onClick={props.onBack}>
              Back
            </Button>
          ) : null}
          {props.onRetry ? (
            <Button size="sm" onClick={props.onRetry}>
              Try again
            </Button>
          ) : null}
        </div>
      </div>
    )
  }
  if (props.loading && !invoice) {
    return props.placeholder ? (
      <InvoiceInspectorPlaceholder invoice={props.placeholder} onBack={props.onBack} />
    ) : (
      <InvoiceInspectorSkeleton />
    )
  }
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
  onEdit,
  onRevise,
  onVoid,
  onMakeRecurring,
  onMove,
  onResync,
  accounting,
  autoOpenPayment,
  onAutoPaymentHandled,
}: BodyProps) {
  const terms = useProductTerminology()
  const labels = receivablesLabels(accounting ?? { ledger: "unavailable", external: null })
  const [section, setSection] = useState<InspectorSection>("summary")
  const [busy, setBusy] = useState<string | null>(null)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [notesDraft, setNotesDraft] = useState(invoice.notes ?? "")
  const [attachments, setAttachments] = useState<AttachedFile[]>(() => mapAttachmentLinks(detail.attachments ?? []))
  const [voidingAdjustmentId, setVoidingAdjustmentId] = useState<string | null>(null)

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

  const scheduledSendAt = scheduledSendAtOf(invoice)
  const handleCancelSchedule = () =>
    withBusy("schedule", async () => {
      try {
        unwrapAction(await cancelScheduledInvoiceSendAction(invoice.id))
        toast.success("Scheduled send cancelled", { description: "The draft stays as it is." })
        await onChanged()
      } catch (error) {
        toast.error("Could not cancel the scheduled send", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })

  // One primary action per invoice, chosen by what the invoice actually needs.
  const primary = (() => {
    if (status === "void") return null
    if (status === "draft" && scheduledSendAt) {
      return { label: "Cancel scheduled send", onClick: handleCancelSchedule, key: "schedule" }
    }
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
    if (balance > 0 && wasIssued) return { label: labels.recordPayment, onClick: () => setPaymentOpen(true), key: "payment" }
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
        return typeof invoice.metadata?.source_pay_application_id === "string"
          ? `${projectBillingHref(resolvedProjectId)}?payapp=${encodeURIComponent(invoice.metadata.source_pay_application_id)}`
          : projectBillingHref(resolvedProjectId)
      case "change_order":
        return `/projects/${resolvedProjectId}/change-orders`
      case "from_costs":
        return `/projects/${resolvedProjectId}/financials/cost-inbox`
      default:
        return null
    }
  })()

  const sections: Array<{ key: InspectorSection; label: string }> = [
    { key: "summary", label: "Summary" },
    { key: "activity", label: "Activity" },
    { key: "attachments", label: "Attachments" },
    { key: "accounting", label: "Accounting" },
  ]

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header: the number, then the money and the one thing to do next, on two short rows. */}
      <div className="shrink-0 border-b">
        <div className="flex items-center gap-2 px-3 pt-2.5">
          {onBack ? (
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onBack} title="Back to list">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          ) : null}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h2 className="truncate text-sm font-semibold leading-tight">
              {invoice.invoice_number || invoice.title || "Untitled invoice"}
            </h2>
            {status !== "overdue" ? <InvoiceStatusBadge invoice={invoice} /> : null}
          </div>
          <InvoiceActionsMenu
            invoice={invoice}
            status={status}
            editable={editable}
            wasIssued={wasIssued}
            hasLink={Boolean(link)}
            busy={busy}
            paymentLabel={labels.recordPayment}
            showPayment={canRecordPayment && primary?.key !== "payment"}
            showAdjust={canAdjust}
            onDownloadPdf={() => void handleDownloadPdf()}
            onCopyLink={() => void handleCopyLink()}
            onRecordPayment={() => setPaymentOpen(true)}
            onAdjust={() => setAdjusting(true)}
            onDuplicate={onDuplicate ? () => onDuplicate(invoice) : undefined}
            onMakeRecurring={onMakeRecurring ? () => onMakeRecurring(invoice) : undefined}
            onRevise={onRevise ? () => onRevise(invoice) : undefined}
            onMove={onMove ? () => onMove(invoice) : undefined}
            onVoid={onVoid ? () => onVoid(invoice) : undefined}
          />
        </div>

        <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
          <p className="flex min-w-0 items-baseline gap-2">
            <span
              className={cn(
                "font-mono text-xl font-semibold tabular-nums",
                status === "overdue" && "text-destructive",
                status === "paid" && "text-success",
              )}
            >
              {formatMoneyFromCents(balance > 0 ? balance : total)}
            </span>
            <span className={cn("truncate text-xs", overdueDaysOf(invoice) > 0 ? "text-destructive" : "text-muted-foreground")}>
              {dueStateLabel(invoice)}
            </span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {/*
              Edit is always where the eye expects it. A draft edits in place; an
              issued invoice cannot change, so Edit there means "revise and
              reissue" and the confirmation says so; a generated draft (from
              costs, a pay app, the fee schedule) is edited at its source.
            */}
            {editable && onEdit ? (
              <Button variant="outline" size="sm" className="h-8" onClick={() => onEdit(invoice)}>
                Edit
              </Button>
            ) : editable && resolvedProjectId ? (
              <Button variant="outline" size="sm" className="h-8" asChild>
                <Link href={resumeInvoiceHref(resolvedProjectId, invoice.id)}>Edit</Link>
              </Button>
            ) : status === "draft" && provenanceHref ? (
              <Button variant="outline" size="sm" className="h-8" asChild title={`Generated from ${invoiceProvenanceLabel(invoice).toLowerCase()} — change it there`}>
                <Link href={provenanceHref}>Edit at source</Link>
              </Button>
            ) : (status === "sent" || status === "overdue") && onRevise ? (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                title="Issued invoices don't change. Editing voids this one and opens a replacement draft."
                onClick={() => onRevise(invoice)}
              >
                Edit
              </Button>
            ) : null}
            {primary ? (
              <Button size="sm" className="h-8" onClick={() => void primary.onClick()} disabled={busy === primary.key}>
                {busy === primary.key ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                {primary.label}
              </Button>
            ) : null}
          </div>
        </div>

        {scheduledSendAt && status === "draft" ? (
          <p className="mx-4 mt-1 border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
            Sends itself {formatScheduledSend(scheduledSendAt)}
            {invoice.sent_to_emails?.length ? ` to ${invoice.sent_to_emails.join(", ")}` : ""}. Edit the draft or cancel until then.
          </p>
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

        <SectionTabs sections={sections} active={section} onChange={setSection} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {section === "summary" ? (
          <div className="space-y-6 p-4">
            <section className="space-y-1 border bg-card p-4">
              <Row label={terms.owner}>{customerNameOf(invoice) || "—"}</Row>
              {typeof invoice.metadata?.memo === "string" && invoice.metadata.memo.trim() ? (
                <Row label="Memo">{invoice.metadata.memo}</Row>
              ) : null}
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

            <InvoiceWaiverCard invoice={invoice} waivers={detail.lienWaivers ?? []}
              payments={detail.payments} reversals={detail.reversals} link={link}
              failed={failed("lien waivers")} onChanged={onChanged} />

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

        {section === "attachments" ? (
          <div className="space-y-3 p-4">
            <p className="text-xs text-muted-foreground">
              Backup that travels with this invoice — receipts, waivers, signed copies. Files here are for your team; the{" "}
              {terms.owner.toLowerCase()} sees the invoice itself and what you share to the portal.
            </p>
            <InvoiceAttachmentsField
              attachments={attachments}
              busy={busy === "attach"}
              canAttach
              onAttach={async (files) => {
                setBusy("attach")
                try {
                  await handleAttach(files)
                } catch (error) {
                  toast.error("Could not attach the file", { description: error instanceof Error ? error.message : "Please try again." })
                } finally {
                  setBusy(null)
                }
              }}
              onDetach={handleDetach}
            />
          </div>
        ) : null}

        {section === "accounting" ? (
          <div className="space-y-6 p-4">
            <p className="text-xs text-muted-foreground">{labels.description}</p>
            {labels.showExternalSync ? (
            <section className="space-y-2">
              <SectionHeading>{accounting?.external?.label ?? DEFAULT_ACCOUNTING_PROVIDER_LABEL} sync</SectionHeading>
              <div className="space-y-2 border bg-card p-3">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <AccountingSyncBadge
                    status={invoice.qbo_sync_status}
                    provider={accounting?.external?.provider}
                    providerLabel={accounting?.external?.label}
                    externalId={invoice.qbo_id ?? undefined}
                    syncedAt={invoice.qbo_synced_at ?? undefined}
                  />
                  <div className="flex items-center gap-3">
                    {accounting?.external?.provider === "qbo" && invoice.qbo_id ? (
                      <a
                        href={qboTxnUrl("invoice", invoice.qbo_id) ?? "#"}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Open in {accounting?.external?.label ?? DEFAULT_ACCOUNTING_PROVIDER_LABEL}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : null}
                    {onResync && labels.canRequestExternalSync ? (
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
                        <AccountingSyncBadge status={log.status} error={log.error_message} provider={accounting?.external?.provider} providerLabel={accounting?.external?.label} />
                        <span>{log.last_synced_at ? new Date(log.last_synced_at).toLocaleDateString() : "—"}</span>
                      </div>
                      {log.error_message ? <p className="mt-0.5 text-destructive">{log.error_message}</p> : null}
                    </div>
                  ))
                )}
              </div>
            </section>
            ) : null}

            {labels.showBooks ? (
            <section className="space-y-2">
              <SectionHeading>{accounting?.ledger === "official" ? "Arc Books · the ledger" : "Arc Books"}</SectionHeading>
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
                  {wasIssued ? "No journal entry has been recorded yet." : "Nothing posts until the invoice is issued."}
                </p>
              )}
            </section>
            ) : null}
            {!labels.showExternalSync && !labels.showBooks ? (
              <p className="border border-dashed bg-card p-3 text-xs text-muted-foreground">
                {labels.description}
              </p>
            ) : null}

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

/**
 * Section tabs whose underline slides to the active tab instead of blinking
 * from one to the next. Measured, not computed: tab widths follow their labels.
 */
function SectionTabs({
  sections,
  active,
  onChange,
}: {
  sections: Array<{ key: InspectorSection; label: string }>
  active: InspectorSection
  onChange: (section: InspectorSection) => void
}) {
  const tabRefs = useRef(new Map<InspectorSection, HTMLButtonElement>())
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null)

  useLayoutEffect(() => {
    const measure = () => {
      const element = tabRefs.current.get(active)
      if (!element) return
      setIndicator({ left: element.offsetLeft, width: element.offsetWidth })
    }
    measure()
    const element = tabRefs.current.get(active)
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active])

  return (
    <nav className="relative mt-1 flex items-center gap-1 px-2" aria-label="Invoice sections">
      {sections.map((entry) => (
        <button
          key={entry.key}
          ref={(node) => {
            if (node) tabRefs.current.set(entry.key, node)
            else tabRefs.current.delete(entry.key)
          }}
          type="button"
          onClick={() => onChange(entry.key)}
          aria-current={active === entry.key ? "page" : undefined}
          className={cn(
            "px-2.5 py-2 text-xs font-medium transition-colors",
            active === entry.key ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {entry.label}
        </button>
      ))}
      <span
        aria-hidden
        className={cn(
          "absolute bottom-0 h-0.5 bg-primary transition-[left,width] duration-200 ease-out motion-reduce:transition-none",
          !indicator && "opacity-0",
        )}
        style={indicator ? { left: indicator.left, width: indicator.width } : undefined}
      />
    </nav>
  )
}

/**
 * Everything else you can do to an invoice, grouped by what it is for and
 * shown only when it applies. A menu of eight items where five are greyed out
 * is a menu that has to be read; one with the three that apply can be scanned.
 */
function InvoiceActionsMenu({
  invoice,
  status,
  editable,
  wasIssued,
  hasLink,
  busy,
  paymentLabel,
  showPayment,
  showAdjust,
  onDownloadPdf,
  onCopyLink,
  onRecordPayment,
  onAdjust,
  onDuplicate,
  onMakeRecurring,
  onRevise,
  onMove,
  onVoid,
}: {
  invoice: Invoice
  status: InvoiceLifecycleStatus
  editable: boolean
  wasIssued: boolean
  hasLink: boolean
  busy: string | null
  paymentLabel: string
  showPayment: boolean
  showAdjust: boolean
  onDownloadPdf: () => void
  onCopyLink: () => void
  onRecordPayment: () => void
  onAdjust: () => void
  onDuplicate?: () => void
  onMakeRecurring?: () => void
  onRevise?: () => void
  onMove?: () => void
  onVoid?: () => void
}) {
  const canRevise = Boolean(onRevise && ["sent", "overdue"].includes(status))
  const canMove = Boolean(onMove && editable)
  const canVoid = Boolean(onVoid && wasIssued && !["paid", "partial", "void"].includes(status))
  const canRecur = Boolean(onMakeRecurring && status !== "void")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">More actions for invoice {invoice.invoice_number}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onDownloadPdf} disabled={busy === "pdf"}>
          <Download className="mr-2 h-4 w-4" />
          Download PDF
        </DropdownMenuItem>
        {wasIssued && hasLink ? (
          <DropdownMenuItem onSelect={onCopyLink}>
            <Copy className="mr-2 h-4 w-4" />
            Copy customer link
          </DropdownMenuItem>
        ) : null}
        {showPayment || showAdjust ? (
          <>
            <DropdownMenuSeparator />
            {showPayment ? <DropdownMenuItem onSelect={onRecordPayment}>{paymentLabel}</DropdownMenuItem> : null}
            {showAdjust ? (
              <DropdownMenuItem onSelect={onAdjust}>
                <MinusCircle className="mr-2 h-4 w-4" />
                Credit or write off
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        {onDuplicate || canRecur || canRevise || canMove ? (
          <>
            <DropdownMenuSeparator />
            {onDuplicate ? <DropdownMenuItem onSelect={onDuplicate}>Duplicate</DropdownMenuItem> : null}
            {canRecur ? <DropdownMenuItem onSelect={onMakeRecurring}>Make recurring…</DropdownMenuItem> : null}
            {canRevise ? <DropdownMenuItem onSelect={onRevise}>Revise and reissue</DropdownMenuItem> : null}
            {canMove ? <DropdownMenuItem onSelect={onMove}>Move to project…</DropdownMenuItem> : null}
          </>
        ) : null}
        {canVoid ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onVoid} className="text-destructive focus:text-destructive">
              Void invoice
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
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
