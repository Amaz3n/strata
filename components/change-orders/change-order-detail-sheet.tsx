"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder, Project } from "@/lib/types"
import type { CommitmentSummary } from "@/lib/services/commitments"
import type { CommitmentChangeOrderSummary, ChangeOrderSubCostSignal } from "@/lib/services/commitment-change-orders"
import { resolveProjectBillingModel } from "@/lib/financials/billing-model"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Clock, Ban } from "@/components/icons"
import { FileText, Link2, Loader2, Receipt, Send, Unlink } from "lucide-react"
import {
  approveChangeOrderAction,
  publishChangeOrderAction,
  voidChangeOrderAction,
  unlinkInvoiceFromChangeOrderAction,
  getChangeOrderLinkedInvoicesAction,
  createCommitmentChangeOrderFromChangeOrderAction,
  getChangeOrderSubCostSignalAction,
  listCommitmentChangeOrdersForChangeOrderAction,
  listCommitmentsForChangeOrderAction,
  linkInvoiceToChangeOrderAction,
  listLinkableInvoicesForChangeOrderAction,
  updateChangeOrderFollowupAction,
  type LinkableChangeOrderInvoice,
} from "@/app/(app)/change-orders/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions"

const statusLabels: Record<string, string> = {
  draft: "Draft",
  pending: "Pending",
  sent: "Sent",
  approved: "Approved",
  requested_changes: "Needs changes",
  cancelled: "Cancelled",
  void: "Void",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  pending: "bg-warning/20 text-warning border-warning/40",
  sent: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  approved: "bg-success/20 text-success border-success/30",
  requested_changes: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  cancelled: "bg-destructive/15 text-destructive border-destructive/30",
  void: "bg-muted text-muted-foreground border-muted",
}

const vendorImpactLabels: Record<string, string> = {
  not_reviewed: "Not reviewed",
  no_vendor_impact: "No vendor impact",
  needs_vendor_pricing: "Needs vendor pricing",
  create_vendor_change: "Vendor CO needed",
  linked_commitment: "Linked to commitment",
}

type LinkedInvoice = {
  id: string
  invoice_number: string
  title: string | null
  status: string
  total_cents: number | null
  balance_due_cents: number | null
  issue_date: string | null
}

interface ChangeOrderDetailSheetProps {
  changeOrder: ChangeOrder | null
  project?: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate?: (changeOrder: ChangeOrder) => void
  onEdit?: (changeOrder: ChangeOrder) => void
  onPrepareInvoice?: (changeOrder: ChangeOrder) => void
}

function formatMoney(cents?: number | null) {
  if (cents == null) return "$0.00"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatGmpClassification(value?: string | null) {
  return value === "outside_gmp" ? "Outside GMP" : "Inside GMP"
}

function formatGmpImpact(value?: string | null) {
  switch (value) {
    case "increase_gmp":
      return "Increases GMP"
    case "decrease_gmp":
      return "Decreases GMP"
    case "outside_gmp":
      return "Outside GMP only"
    default:
      return "No GMP change"
  }
}

function todayDateInputValue() {
  return format(new Date(), "yyyy-MM-dd")
}

export function ChangeOrderDetailSheet({
  changeOrder,
  project,
  open,
  onOpenChange,
  onUpdate,
  onEdit,
  onPrepareInvoice,
}: ChangeOrderDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approvalDialogOpen, setApprovalDialogOpen] = useState(false)
  const [offlineApprovalDate, setOfflineApprovalDate] = useState(todayDateInputValue)
  const [offlineSignerName, setOfflineSignerName] = useState("")
  const [offlineSignerEmail, setOfflineSignerEmail] = useState("")
  const [offlineApprovalNote, setOfflineApprovalNote] = useState("")
  const [offlineSignedFile, setOfflineSignedFile] = useState<File | null>(null)
  const offlineFileInputRef = useRef<HTMLInputElement>(null)
  const [sendingToClient, setSendingToClient] = useState(false)
  const [voidDialogOpen, setVoidDialogOpen] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [voiding, setVoiding] = useState(false)
  const [savingFollowup, setSavingFollowup] = useState(false)

  const [linkedInvoices, setLinkedInvoices] = useState<LinkedInvoice[]>([])
  const [linkedInvoicesLoading, setLinkedInvoicesLoading] = useState(false)
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkableInvoices, setLinkableInvoices] = useState<LinkableChangeOrderInvoice[]>([])
  const [linkableLoading, setLinkableLoading] = useState(false)
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set())
  const [linkingInvoices, setLinkingInvoices] = useState(false)
  const [unlinkingInvoiceId, setUnlinkingInvoiceId] = useState<string | null>(null)
  const [linkedCommitmentChangeOrders, setLinkedCommitmentChangeOrders] = useState<CommitmentChangeOrderSummary[]>([])
  const [subCostSignal, setSubCostSignal] = useState<ChangeOrderSubCostSignal | null>(null)
  const [subCostLoading, setSubCostLoading] = useState(false)
  const [commitmentPickerOpen, setCommitmentPickerOpen] = useState(false)
  const [commitmentOptions, setCommitmentOptions] = useState<CommitmentSummary[]>([])
  const [selectedCommitmentId, setSelectedCommitmentId] = useState("")
  const [creatingCommitmentChangeOrder, setCreatingCommitmentChangeOrder] = useState(false)

  const loadLinkedInvoices = useCallback(async () => {
    if (!changeOrder) return
    setLinkedInvoicesLoading(true)
    try {
      const invoices = await getChangeOrderLinkedInvoicesAction(changeOrder.id)
      setLinkedInvoices((invoices as LinkedInvoice[]) ?? [])
    } catch {
      setLinkedInvoices([])
    } finally {
      setLinkedInvoicesLoading(false)
    }
  }, [changeOrder])

  const loadSubCostLinks = useCallback(async () => {
    if (!changeOrder) return
    setSubCostLoading(true)
    try {
      const [links, signal] = await Promise.all([
        listCommitmentChangeOrdersForChangeOrderAction(changeOrder.id),
        getChangeOrderSubCostSignalAction(changeOrder.id),
      ])
      setLinkedCommitmentChangeOrders((links as CommitmentChangeOrderSummary[]) ?? [])
      setSubCostSignal(signal as ChangeOrderSubCostSignal)
    } catch {
      setLinkedCommitmentChangeOrders([])
      setSubCostSignal(null)
    } finally {
      setSubCostLoading(false)
    }
  }, [changeOrder])

  useEffect(() => {
    if (open && changeOrder) {
      void loadLinkedInvoices()
      void loadSubCostLinks()
    } else if (!open) {
      setLinkedInvoices([])
      setLinkedCommitmentChangeOrders([])
      setSubCostSignal(null)
      setLinkPickerOpen(false)
      setCommitmentPickerOpen(false)
      setSelectedInvoiceIds(new Set())
      setSelectedCommitmentId("")
    }
  }, [open, changeOrder, loadLinkedInvoices, loadSubCostLinks])

  async function openLinkPicker() {
    if (!changeOrder) return
    setLinkPickerOpen(true)
    setLinkableLoading(true)
    try {
      const invoices = await listLinkableInvoicesForChangeOrderAction(changeOrder.project_id)
      setLinkableInvoices(invoices ?? [])
    } catch (error: any) {
      toast.error("Could not load invoices", { description: error?.message ?? "Please try again." })
      setLinkableInvoices([])
    } finally {
      setLinkableLoading(false)
    }
  }

  async function handleLinkSelected() {
    if (!changeOrder || selectedInvoiceIds.size === 0) return
    setLinkingInvoices(true)
    try {
      for (const invoiceId of selectedInvoiceIds) {
        await linkInvoiceToChangeOrderAction(changeOrder.project_id, changeOrder.id, invoiceId)
      }
      setLinkPickerOpen(false)
      setSelectedInvoiceIds(new Set())
      await loadLinkedInvoices()
      toast.success(selectedInvoiceIds.size > 1 ? "Invoices linked to change order" : "Invoice linked to change order")
    } catch (error: any) {
      toast.error("Could not link invoice", { description: error?.message ?? "Please try again." })
    } finally {
      setLinkingInvoices(false)
    }
  }

  async function handleUnlinkInvoice(invoiceId: string) {
    if (!changeOrder) return
    setUnlinkingInvoiceId(invoiceId)
    try {
      await unlinkInvoiceFromChangeOrderAction(changeOrder.project_id, changeOrder.id, invoiceId)
      await loadLinkedInvoices()
      toast.success("Invoice unlinked")
    } catch (error: any) {
      toast.error("Could not unlink invoice", { description: error?.message ?? "Please try again." })
    } finally {
      setUnlinkingInvoiceId(null)
    }
  }

  const loadAttachments = useCallback(async () => {
    if (!changeOrder) return

    setIsLoadingAttachments(true)
    try {
      const links = await listAttachmentsAction("change_order", changeOrder.id)
      setAttachments(
        links.map((link) => ({
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
      )
    } catch (error) {
      console.error("Failed to load attachments:", error)
    } finally {
      setIsLoadingAttachments(false)
    }
  }, [changeOrder])

  useEffect(() => {
    if (open && changeOrder) {
      loadAttachments()
    }
  }, [open, changeOrder, loadAttachments])

  useEffect(() => {
    if (!open) setSendingToClient(false)
  }, [open])

  const handleAttach = useCallback(
    async (files: File[], linkRole?: string) => {
      if (!changeOrder) return

      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", changeOrder.project_id)
        formData.append("category", "contracts")

        const uploaded = await uploadFileAction(formData)
        await attachFileAction(uploaded.id, "change_order", changeOrder.id, changeOrder.project_id, linkRole)
      }

      await loadAttachments()
    },
    [changeOrder, loadAttachments]
  )

  const handleDetach = useCallback(
    async (linkId: string) => {
      await detachFileLinkAction(linkId)
      await loadAttachments()
    },
    [loadAttachments]
  )

  if (!changeOrder) return null

  const formatDate = (date?: string | null) => {
    if (!date) return null
    return format(new Date(date), "MMM d, yyyy")
  }
  const formatDateTime = (date?: string | null) => {
    if (!date) return null
    return format(new Date(date), "MMM d, yyyy h:mm a")
  }

  const totalCents = changeOrder.total_cents ?? changeOrder.totals?.total_cents ?? 0
  const isVoided = changeOrder.status === "cancelled"
  const isGmpProject = project ? resolveProjectBillingModel(project) === "cost_plus_gmp" : false
  const canApprove = changeOrder.status !== "approved" && !isVoided
  const canVoid = changeOrder.status === "approved"
  const metadata = changeOrder.metadata ?? {}
  const vendorImpactStatus =
    typeof metadata.vendor_impact_status === "string" ? metadata.vendor_impact_status : "not_reviewed"
  const financialImpact = (metadata.financial_impact as Record<string, any> | undefined) ?? null
  const budgetPostingStatus =
    financialImpact?.billing_status === "ready_to_bill"
      ? "Budget posted"
      : financialImpact?.billing_status === "tracking_only"
        ? "Tracking only"
        : changeOrder.status === "approved"
          ? "Not posted"
          : "Pending approval"
  const summaryText = changeOrder.summary?.trim() || ""
  const descriptionText = changeOrder.description?.trim() || ""
  const showDescription = Boolean(descriptionText && descriptionText !== summaryText)
  const billingStatus =
    changeOrder.status !== "approved"
      ? "Not approved"
      : linkedInvoices.length > 0 || changeOrder.linked_invoice
        ? "Billed"
        : "Ready to bill"
  const signatureData = (metadata.signature_data as Record<string, any> | undefined)?.client ?? null
  const portalChangeRequests = Array.isArray(metadata.portal_change_requests) ? metadata.portal_change_requests : []
  const latestChangeRequest =
    portalChangeRequests.length > 0
      ? portalChangeRequests[portalChangeRequests.length - 1]
      : typeof metadata.portal_change_request_note === "string"
        ? {
            note: metadata.portal_change_request_note,
            requested_at: metadata.portal_change_requested_at,
            name: metadata.portal_change_requested_by_name,
            email: metadata.portal_change_requested_by_email,
          }
        : null
  const hasActiveClientChangeRequest =
    metadata.portal_change_request_active === false
      ? false
      : changeOrder.status === "requested_changes" || metadata.portal_change_request_active === true
  const resolvedStatus = changeOrder.status !== "approved" && hasActiveClientChangeRequest ? "requested_changes" : changeOrder.status
  const canEdit = !["approved", "cancelled", "void"].includes(resolvedStatus)
  const canSendToClient = resolvedStatus === "draft" || resolvedStatus === "requested_changes"
  const activityItems = [
    { label: "Created", value: formatDateTime(changeOrder.created_at), detail: "Change order was drafted in Arc." },
    metadata.email_sent_at || metadata.published_at
      ? {
          label: metadata.email_sent ? "Sent to client" : "Published to portal",
          value: formatDateTime((metadata.email_sent_at as string | undefined) ?? (metadata.published_at as string | undefined)),
          detail: metadata.sent_to ? `Recipient: ${metadata.sent_to}` : "Client portal access was enabled.",
        }
      : null,
    metadata.portal_last_viewed_at
      ? {
          label: "Opened by client",
          value: formatDateTime(metadata.portal_last_viewed_at as string),
          detail: "Client viewed the change order portal.",
        }
      : null,
    latestChangeRequest
      ? {
          label: "Changes requested",
          value: formatDateTime(latestChangeRequest.requested_at ?? metadata.portal_change_requested_at as string | undefined),
          detail: latestChangeRequest.note ?? "Client requested revisions.",
        }
      : null,
    changeOrder.approved_at
      ? {
          label: "Signed and approved",
          value: formatDateTime(signatureData?.signed_at ?? changeOrder.approved_at),
          detail:
            metadata.approved_signer_email || metadata.approved_signer_name
              ? [metadata.approved_signer_name, metadata.approved_signer_email].filter(Boolean).join(" · ")
              : "Approval was recorded.",
        }
      : null,
    linkedInvoices.length > 0
      ? {
          label: linkedInvoices.length > 1 ? "Invoices linked" : "Invoice linked",
          value: formatDateTime(linkedInvoices[0]?.issue_date),
          detail: linkedInvoices.map((invoice) => `Invoice ${invoice.invoice_number}`).join(", "),
        }
      : null,
  ].filter(Boolean) as Array<{ label: string; value: string | null; detail: string }>

  const resetOfflineApproval = () => {
    setOfflineApprovalDate(todayDateInputValue())
    setOfflineSignerName("")
    setOfflineSignerEmail("")
    setOfflineApprovalNote("")
    setOfflineSignedFile(null)
  }

  const openOfflineApprovalDialog = () => {
    if (!canApprove) return
    resetOfflineApproval()
    setApprovalDialogOpen(true)
  }

  const handleApprove = async () => {
    if (!canApprove) return
    if (!offlineApprovalDate) {
      toast.error("Approval date is required")
      return
    }
    if (offlineSignerName.trim().length < 2) {
      toast.error("Signer name is required")
      return
    }
    setApproving(true)
    try {
      let signedFileId: string | undefined
      if (offlineSignedFile) {
        const formData = new FormData()
        formData.append("file", offlineSignedFile)
        formData.append("projectId", changeOrder.project_id)
        formData.append("category", "contracts")
        const uploaded = await uploadFileAction(formData)
        signedFileId = uploaded.id
      }

      const updated = await approveChangeOrderAction(changeOrder.id, {
        approvedAt: offlineApprovalDate,
        signerName: offlineSignerName,
        signerEmail: offlineSignerEmail,
        note: offlineApprovalNote,
        signedFileId,
      })
      onUpdate?.(updated)
      setApprovalDialogOpen(false)
      resetOfflineApproval()
      await loadAttachments()
      toast.success("Offline approval recorded", {
        description: "Financial impact has been posted from the approved change order.",
      })
    } catch (error: any) {
      toast.error("Failed to approve", { description: error?.message ?? "Please try again." })
    } finally {
      setApproving(false)
    }
  }

  const handleVoid = async () => {
    if (!canVoid) return
    setVoiding(true)
    try {
      const updated = await voidChangeOrderAction(changeOrder.id, voidReason)
      onUpdate?.(updated)
      setVoidDialogOpen(false)
      setVoidReason("")
      toast.success("Change order voided", {
        description: isGmpProject
          ? "Its impact on the contract value, GMP, budget, and draws has been reversed."
          : "Its impact on the contract value, budget, and draws has been reversed.",
      })
    } catch (error: any) {
      toast.error("Could not void change order", { description: error?.message ?? "Please try again." })
    } finally {
      setVoiding(false)
    }
  }

  const handleSendToClient = async () => {
    if (!changeOrder.project_id) return
    setSendingToClient(true)
    try {
      const result = await publishChangeOrderAction(changeOrder.id)
      onUpdate?.(result.changeOrder)
      toast.success(result.email_sent ? "Change order emailed to client" : "Change order published to client portal", {
        description: result.email_sent
          ? `Sent to ${result.sent_to}.`
          : "Email was not sent, but the client portal link is ready.",
      })
    } catch (error: any) {
      toast.error("Could not send change order", { description: error?.message ?? "Please try again." })
    } finally {
      setSendingToClient(false)
    }
  }

  const handleVendorImpactChange = async (value: string) => {
    if (!changeOrder) return
    setSavingFollowup(true)
    try {
      const updated = await updateChangeOrderFollowupAction(changeOrder.id, { vendor_impact_status: value })
      onUpdate?.({ ...changeOrder, ...updated })
      toast.success("Vendor impact updated")
    } catch (error: any) {
      toast.error("Could not update vendor impact", { description: error?.message ?? "Please try again." })
    } finally {
      setSavingFollowup(false)
    }
  }

  const openCommitmentPicker = async () => {
    if (!changeOrder.project_id) return
    setCommitmentPickerOpen(true)
    try {
      const commitments = await listCommitmentsForChangeOrderAction(changeOrder.project_id)
      setCommitmentOptions(commitments)
      setSelectedCommitmentId(commitments[0]?.id ?? "")
    } catch (error: any) {
      toast.error("Could not load commitments", { description: error?.message ?? "Please try again." })
      setCommitmentOptions([])
      setSelectedCommitmentId("")
    }
  }

  const handleCreateCommitmentChangeOrder = async () => {
    if (!changeOrder.project_id || !selectedCommitmentId) return
    setCreatingCommitmentChangeOrder(true)
    try {
      await createCommitmentChangeOrderFromChangeOrderAction(
        changeOrder.project_id,
        changeOrder.id,
        selectedCommitmentId,
      )
      await loadSubCostLinks()
      setCommitmentPickerOpen(false)
      toast.success("Commitment change order drafted")
    } catch (error: any) {
      toast.error("Could not create commitment change order", { description: error?.message ?? "Please try again." })
    } finally {
      setCreatingCommitmentChangeOrder(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation [&>button]:hidden"
          style={{
            animationDuration: "150ms",
            transitionDuration: "150ms",
          }}
        >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <div className="flex items-start gap-4">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-left text-lg leading-6">
                {changeOrder.title}
              </SheetTitle>
              {(changeOrder.status === "approved" || (changeOrder.days_impact != null && changeOrder.days_impact !== 0)) ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {changeOrder.status === "approved" ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                      Approved{changeOrder.approved_at ? ` ${formatDate(changeOrder.approved_at)}` : ""}
                    </span>
                  ) : null}
                  {changeOrder.days_impact != null && changeOrder.days_impact !== 0 ? (
                    <>
                      {changeOrder.status === "approved" ? <span aria-hidden="true">·</span> : null}
                      <span>
                        {changeOrder.days_impact > 0 ? "+" : ""}{changeOrder.days_impact} day{Math.abs(changeOrder.days_impact) === 1 ? "" : "s"}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
            {changeOrder.status !== "approved" ? (
              <Badge
                variant="secondary"
                className={`shrink-0 capitalize border ${statusStyles[changeOrder.status] ?? ""}`}
              >
                {statusLabels[changeOrder.status] ?? changeOrder.status}
              </Badge>
            ) : null}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4 space-y-6">

          {summaryText && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Scope & Notes</h4>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap">{summaryText}</p>
              </div>
            </div>
          )}

          {showDescription ? (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Description</h4>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap">{descriptionText}</p>
              </div>
            </div>
          ) : null}

          {hasActiveClientChangeRequest && latestChangeRequest ? (
            <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-foreground">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">Client requested changes</h4>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[latestChangeRequest.name, latestChangeRequest.email].filter(Boolean).join(" · ") || "Client"}
                    {latestChangeRequest.requested_at ? ` · ${formatDateTime(latestChangeRequest.requested_at)}` : ""}
                  </p>
                </div>
                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300">
                  Needs changes
                </Badge>
              </div>
              <p className="whitespace-pre-line text-sm leading-6">{latestChangeRequest.note}</p>
            </div>
          ) : null}

          {/* Pricing */}
          {((changeOrder.lines?.length ?? 0) > 0 || changeOrder.totals) && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Pricing</h4>
              <div className="overflow-hidden rounded-xl border bg-background">
                {changeOrder.lines?.map((line, idx) => {
                  const lineTotal = (line.quantity ?? 1) * (line.unit_cost_cents ?? 0) + (line.allowance_cents ?? 0)
                  return (
                    <div key={line.id ?? idx} className="border-b px-4 py-3.5 last:border-b-0">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <p className="text-sm font-medium leading-5">{line.description}</p>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {line.quantity ?? 1} {line.unit ?? "units"} × {formatMoney(line.unit_cost_cents)}
                            </span>
                            {line.allowance_cents != null && line.allowance_cents !== 0 ? (
                              <span>· {formatMoney(line.allowance_cents)} allowance</span>
                            ) : null}
                            {line.taxable ? <span>· Taxable</span> : null}
                            {isGmpProject && (line.gmp_classification || line.gmp_impact) ? (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                                {formatGmpClassification(line.gmp_classification)}
                              </Badge>
                            ) : null}
                            {isGmpProject && line.gmp_impact && line.gmp_impact !== "none" ? (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                                {formatGmpImpact(line.gmp_impact)}
                              </Badge>
                            ) : null}
                          </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatMoney(lineTotal)}
                        </span>
                      </div>
                    </div>
                  )
                })}
                <div className="space-y-2 border-t bg-muted/30 px-4 py-3 text-sm">
                  {changeOrder.totals ? (
                    <>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Subtotal</span>
                        <span className="tabular-nums">{formatMoney(changeOrder.totals.subtotal_cents)}</span>
                      </div>
                      {changeOrder.totals.allowance_cents != null && changeOrder.totals.allowance_cents !== 0 ? (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Allowances</span>
                          <span className="tabular-nums">{formatMoney(changeOrder.totals.allowance_cents)}</span>
                        </div>
                      ) : null}
                      {changeOrder.totals.markup_cents != null && changeOrder.totals.markup_cents > 0 ? (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Markup ({changeOrder.totals.markup_percent ?? 0}%)</span>
                          <span className="tabular-nums">{formatMoney(changeOrder.totals.markup_cents)}</span>
                        </div>
                      ) : null}
                      {changeOrder.totals.tax_cents != null && changeOrder.totals.tax_cents > 0 ? (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Tax ({changeOrder.totals.tax_rate ?? 0}%)</span>
                          <span className="tabular-nums">{formatMoney(changeOrder.totals.tax_cents)}</span>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                  <div className="flex justify-between border-t pt-2 text-base font-semibold">
                    <span>Total</span>
                    <span className="tabular-nums">{formatMoney(changeOrder.totals?.total_cents ?? totalCents)}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {(changeOrder.status === "approved" || financialImpact) ? (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Financial impact</h4>
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 sm:grid-cols-3">
                <div>
                  <p className="text-[11px] font-medium uppercase text-muted-foreground">Contract change</p>
                  <p className="mt-1 text-sm font-semibold tabular-nums">{formatMoney(totalCents)}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium uppercase text-muted-foreground">Budget posting</p>
                  <p className="mt-1 text-sm font-semibold">{budgetPostingStatus}</p>
                  {financialImpact?.posting_skipped_reason ? (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">{financialImpact.posting_skipped_reason}</p>
                  ) : financialImpact?.budget_revision_cents != null ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatMoney(Number(financialImpact.budget_revision_cents))} revision
                    </p>
                  ) : null}
                </div>
                {isGmpProject ? (
                  <div>
                    <p className="text-[11px] font-medium uppercase text-muted-foreground">GMP delta</p>
                    <p className="mt-1 text-sm font-semibold tabular-nums">
                      {formatMoney(typeof financialImpact?.gmp_delta_cents === "number" ? financialImpact.gmp_delta_cents : 0)}
                    </p>
                    <p className="mt-1 text-xs capitalize text-muted-foreground">
                      {String(financialImpact?.gmp_impact ?? "none").replace(/_/g, " ")}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="text-[11px] font-medium uppercase text-muted-foreground">Billing status</p>
                    <p className="mt-1 text-sm font-semibold">{billingStatus}</p>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {/* Linked receivable invoices */}
          {changeOrder.status === "approved" ? (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">Post-approval follow-up</h4>
                  <p className="text-xs text-muted-foreground">Close the vendor and billing loop for this approved change.</p>
                </div>
                <Badge variant={billingStatus === "Ready to bill" ? "secondary" : "outline"} className="shrink-0">
                  {billingStatus}
                </Badge>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">Vendor impact</label>
                  <Select value={vendorImpactStatus} onValueChange={handleVendorImpactChange} disabled={savingFollowup}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(vendorImpactLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {linkedInvoices.length === 0 ? (
                  <Button type="button" onClick={() => onPrepareInvoice?.(changeOrder)} disabled={!project}>
                    <Receipt className="mr-2 h-4 w-4" />
                    Prepare invoice
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {changeOrder.status === "approved" ? (
            <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-semibold">Sub cost</h4>
                  <p className="text-xs text-muted-foreground">Create or review subcontract change orders tied to this client CO.</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={openCommitmentPicker} disabled={subCostLoading}>
                  <Link2 className="mr-2 h-4 w-4" />
                  Create CCO
                </Button>
              </div>
              {subCostSignal && !subCostSignal.has_linked_commitment_change_orders && subCostSignal.matching_commitments.length > 0 ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                  Sold but not bought: {subCostSignal.matching_commitments.length} matching commitment{subCostSignal.matching_commitments.length === 1 ? "" : "s"} may need a CCO.
                </div>
              ) : null}
              {subCostLoading ? (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading subcontract impact…
                </div>
              ) : linkedCommitmentChangeOrders.length > 0 ? (
                <div className="space-y-2">
                  {linkedCommitmentChangeOrders.map((cco) => (
                    <div key={cco.id} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{cco.title}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {cco.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {cco.company_name ?? "No vendor"} · {cco.commitment_title ?? "Commitment"}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {cco.total_cents > 0 ? "+" : ""}
                        {formatMoney(cco.total_cents)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No subcontract change orders are linked to this client change order yet.
                </p>
              )}
            </div>
          ) : null}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Linked invoices</h4>
              {!linkedInvoicesLoading && (
                <Button type="button" variant="outline" size="sm" onClick={openLinkPicker}>
                  <Link2 className="mr-2 h-4 w-4" />
                  Link existing invoice
                </Button>
              )}
            </div>
            {linkedInvoicesLoading ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading linked invoices…
              </div>
            ) : linkedInvoices.length > 0 ? (
              <div className="space-y-2">
                {linkedInvoices.map((linkedInvoice) => (
                  <div key={linkedInvoice.id} className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 p-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <Receipt className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">Invoice {linkedInvoice.invoice_number}</span>
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {linkedInvoice.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {formatMoney(linkedInvoice.total_cents)} total
                          {linkedInvoice.balance_due_cents != null
                            ? ` · ${formatMoney(linkedInvoice.balance_due_cents)} balance`
                            : ""}
                        </p>
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => handleUnlinkInvoice(linkedInvoice.id)}
                      disabled={unlinkingInvoiceId === linkedInvoice.id}
                      title="Unlink invoice from this change order"
                    >
                      {unlinkingInvoiceId === linkedInvoice.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                      <span className="sr-only">Unlink invoice</span>
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Attach an existing or QuickBooks-synced invoice to record that this change order has already been billed.
              </p>
            )}
          </div>

          <Separator />

          {/* Attachments */}
          <div className="[&_button]:hidden [&_div[class*='border-dashed']]:!border-solid">
            <EntityAttachments
              entityType="change_order"
              entityId={changeOrder.id}
              projectId={changeOrder.project_id}
              attachments={attachments}
              onAttach={handleAttach}
              onDetach={handleDetach}
              title="Supporting Documents"
              description="Photos, quotes, specs, or other supporting documents for this change order"
            />
          </div>

          {/* Activity */}
          <Accordion type="single" collapsible className="w-full">
            <AccordionItem value="activity" className="border-none">
              <AccordionTrigger className="text-sm font-medium py-2 hover:no-underline">
                Activity
              </AccordionTrigger>
              <AccordionContent>
                  <div className="space-y-3 pt-2">
                    {activityItems.map((item) => (
                      <div key={`${item.label}-${item.value ?? item.detail}`} className="flex gap-3 text-sm">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-background">
                          {item.label.includes("Sent") || item.label.includes("Published") ? (
                            <Send className="h-3 w-3 text-muted-foreground" />
                          ) : item.label.includes("Invoice") ? (
                            <Receipt className="h-3 w-3 text-muted-foreground" />
                          ) : (
                            <Clock className="h-3 w-3 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <p className="font-medium text-foreground">{item.label}</p>
                            {item.value ? <p className="text-xs text-muted-foreground">{item.value}</p> : null}
                          </div>
                          <p className="mt-0.5 whitespace-pre-line text-xs text-muted-foreground">{item.detail}</p>
                        </div>
                      </div>
                    ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
          </div>
        </ScrollArea>

        {/* Footer */}
          <div className="flex-shrink-0 border-t bg-muted/30 p-4">
            {isVoided ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <Ban className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-medium">This change order has been voided.</p>
                    <p className="text-xs text-destructive/80">
                      {isGmpProject
                        ? "Its impact on the contract value, GMP, budget, and draw schedule was reversed."
                        : "Its impact on the contract value, budget, and draw schedule was reversed."}
                      {changeOrder.metadata?.void_reason ? ` Reason: ${changeOrder.metadata.void_reason}` : ""}
                    </p>
                  </div>
                </div>
                <Button variant="outline" onClick={() => onOpenChange(false)} className="w-full">
                  Close
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button variant="outline" onClick={() => onOpenChange(false)} className="sm:w-auto">
                  Close
                </Button>
                <Button variant="outline" asChild className="sm:w-auto">
                  <a href={`/change-orders/${changeOrder.id}/export`} target="_blank" rel="noopener noreferrer">
                    <FileText className="mr-2 h-4 w-4" />
                    PDF
                  </a>
                </Button>
                <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:justify-end">
                  {canEdit ? (
                    <Button type="button" variant="outline" onClick={() => onEdit?.(changeOrder)}>
                      Edit
                    </Button>
                  ) : null}
                  {resolvedStatus === "approved" ? (
                    <>
                      <Button
                        type="button"
                        onClick={() => onPrepareInvoice?.(changeOrder)}
                        disabled={!project || linkedInvoicesLoading || linkedInvoices.length > 0}
                      >
                        <Receipt className="mr-2 h-4 w-4" />
                        {linkedInvoices.length > 0 ? "Invoice prepared" : "Prepare invoice"}
                      </Button>
                      <Button
                        onClick={() => setVoidDialogOpen(true)}
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                      >
                        <Ban className="mr-2 h-4 w-4" />
                        Void
                      </Button>
                    </>
                  ) : (
                    <>
                      {canApprove ? (
                        <Button type="button" variant="outline" onClick={openOfflineApprovalDialog} disabled={approving}>
                          {approving ? "Recording..." : "Record offline approval"}
                        </Button>
                      ) : null}
                      {canSendToClient ? (
                        <Button
                          type="button"
                          onClick={handleSendToClient}
                          disabled={!changeOrder.project_id || sendingToClient}
                        >
                          {sendingToClient
                            ? "Sending..."
                            : resolvedStatus === "requested_changes"
                              ? "Resend to client portal"
                              : "Send to client portal"}
                        </Button>
                      ) : (
                        <Button type="button" disabled>
                          Sent to client
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Dialog
        open={approvalDialogOpen}
        onOpenChange={(open) => {
          setApprovalDialogOpen(open)
          if (!open) resetOfflineApproval()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record offline approval</DialogTitle>
            <DialogDescription>
              Use this when the client approved this change order outside Arc and you need to post its financial impact.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="offline-approval-date" className="text-sm font-medium">
                  Approval date
                </label>
                <Input
                  id="offline-approval-date"
                  type="date"
                  value={offlineApprovalDate}
                  onChange={(event) => setOfflineApprovalDate(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="offline-signer-name" className="text-sm font-medium">
                  Signer name
                </label>
                <Input
                  id="offline-signer-name"
                  value={offlineSignerName}
                  onChange={(event) => setOfflineSignerName(event.target.value)}
                  placeholder="Client name"
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="offline-signer-email" className="text-sm font-medium">
                Signer email <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                id="offline-signer-email"
                type="email"
                value={offlineSignerEmail}
                onChange={(event) => setOfflineSignerEmail(event.target.value)}
                placeholder="client@example.com"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Signed document</label>
              <input
                ref={offlineFileInputRef}
                type="file"
                accept="application/pdf,image/*"
                className="hidden"
                onChange={(event) => setOfflineSignedFile(event.target.files?.[0] ?? null)}
              />
              <Button type="button" variant="outline" className="w-full justify-start" onClick={() => offlineFileInputRef.current?.click()}>
                {offlineSignedFile ? offlineSignedFile.name : "Choose signed file"}
              </Button>
            </div>
            <div className="space-y-2">
              <label htmlFor="offline-approval-note" className="text-sm font-medium">
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <Textarea
                id="offline-approval-note"
                value={offlineApprovalNote}
                onChange={(event) => setOfflineApprovalNote(event.target.value)}
                placeholder="Who approved, where the approval is stored, or any context accounting should know."
                rows={3}
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setApprovalDialogOpen(false)} disabled={approving}>
              Cancel
            </Button>
            <Button onClick={handleApprove} disabled={approving || !offlineApprovalDate || offlineSignerName.trim().length < 2}>
              {approving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Record approval
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={voidDialogOpen}
        onOpenChange={(open) => {
          setVoidDialogOpen(open)
          if (!open) setVoidReason("")
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Void this change order?</DialogTitle>
            <DialogDescription>
              Voiding reverses {changeOrder.title}&apos;s impact on the contract value
              {isGmpProject ? ", GMP," : ","} budget, and pending draws.
              The change order is kept for the record but marked cancelled. This is the right way to back out an
              approved change order — it can&apos;t be deleted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="void-reason" className="text-sm font-medium">
              Reason <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id="void-reason"
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="e.g. Approved by mistake, scope no longer applies…"
              rows={3}
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setVoidDialogOpen(false)} disabled={voiding}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleVoid} disabled={voiding}>
              {voiding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Void change order
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={commitmentPickerOpen} onOpenChange={setCommitmentPickerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create commitment change order</DialogTitle>
            <DialogDescription>
              Select the subcontract or PO that should absorb this client change order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {commitmentOptions.length === 0 ? (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                No commitments found for this project.
              </p>
            ) : (
              <div className="space-y-2">
                <label className="text-sm font-medium">Commitment</label>
                <Select value={selectedCommitmentId} onValueChange={setSelectedCommitmentId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select commitment" />
                  </SelectTrigger>
                  <SelectContent>
                    {commitmentOptions.map((commitment) => (
                      <SelectItem key={commitment.id} value={commitment.id}>
                        {commitment.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedCommitmentId ? (
                  <p className="text-xs text-muted-foreground">
                    {(() => {
                      const selected = commitmentOptions.find((commitment) => commitment.id === selectedCommitmentId)
                      if (!selected) return null
                      return `${selected.company_name ?? "No vendor"} · ${formatMoney(selected.revised_total_cents ?? selected.total_cents ?? 0)} revised`
                    })()}
                  </p>
                ) : null}
              </div>
            )}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCommitmentPickerOpen(false)} disabled={creatingCommitmentChangeOrder}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateCommitmentChangeOrder}
              disabled={creatingCommitmentChangeOrder || !selectedCommitmentId}
            >
              {creatingCommitmentChangeOrder && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create CCO
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={linkPickerOpen} onOpenChange={(open) => {
        setLinkPickerOpen(open)
        if (!open) setSelectedInvoiceIds(new Set())
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link existing invoice</DialogTitle>
            <DialogDescription>
              Choose an invoice for this project to tie to {changeOrder.title}. Already-linked, draw-linked, and voided
              invoices are excluded.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-2 overflow-y-auto">
            {linkableLoading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading invoices…
              </div>
            ) : linkableInvoices.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No linkable invoices found for this project.</p>
            ) : (
              linkableInvoices.map((invoice) => {
                const isSelected = selectedInvoiceIds.has(invoice.id)
                return (
                  <button
                    key={invoice.id}
                    type="button"
                    onClick={() => {
                      const next = new Set(selectedInvoiceIds)
                      if (isSelected) next.delete(invoice.id)
                      else next.add(invoice.id)
                      setSelectedInvoiceIds(next)
                    }}
                    disabled={linkingInvoices}
                    className="flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
                  >
                    <Checkbox checked={isSelected} className="pointer-events-none" />
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Receipt className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">Invoice {invoice.invoice_number}</span>
                          {invoice.from_qbo && (
                            <Badge variant="outline" className="text-[10px]">
                              QBO
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px] capitalize">
                            {invoice.status}
                          </Badge>
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {formatMoney(invoice.total_cents)}
                          {invoice.title ? ` · ${invoice.title}` : ""}
                        </p>
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
          {linkableInvoices.length > 0 && !linkableLoading && (
            <div className="mt-4 flex justify-end">
              <Button onClick={handleLinkSelected} disabled={linkingInvoices || selectedInvoiceIds.size === 0}>
                {linkingInvoices && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Link Selected
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </>
  )
}
