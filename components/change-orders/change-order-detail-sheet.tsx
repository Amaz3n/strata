"use client"

import { useState, useCallback, useEffect } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder, Project } from "@/lib/types"
import { resolveProjectBillingModel } from "@/lib/financials/billing-model"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { Textarea } from "@/components/ui/textarea"
import { Clock, Ban } from "@/components/icons"
import { Link2, Loader2, Receipt, Unlink } from "lucide-react"
import {
  approveChangeOrderAction,
  voidChangeOrderAction,
  unlinkInvoiceFromChangeOrderAction,
  getChangeOrderLinkedInvoicesAction,
  linkInvoiceToChangeOrderAction,
  listLinkableInvoicesForChangeOrderAction,
  type LinkableChangeOrderInvoice,
} from "@/app/(app)/change-orders/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { EnvelopeWizard } from "@/components/esign/envelope-wizard"
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
  requested_changes: "bg-amber-100 text-amber-800 border-amber-200",
  cancelled: "bg-destructive/15 text-destructive border-destructive/30",
  void: "bg-muted text-muted-foreground border-muted",
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

export function ChangeOrderDetailSheet({
  changeOrder,
  project,
  open,
  onOpenChange,
  onUpdate,
  onPrepareInvoice,
}: ChangeOrderDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false)
  const [approving, setApproving] = useState(false)
  const [signatureWizardOpen, setSignatureWizardOpen] = useState(false)
  const [voidDialogOpen, setVoidDialogOpen] = useState(false)
  const [voidReason, setVoidReason] = useState("")
  const [voiding, setVoiding] = useState(false)

  const [linkedInvoices, setLinkedInvoices] = useState<LinkedInvoice[]>([])
  const [linkedInvoicesLoading, setLinkedInvoicesLoading] = useState(false)
  const [linkPickerOpen, setLinkPickerOpen] = useState(false)
  const [linkableInvoices, setLinkableInvoices] = useState<LinkableChangeOrderInvoice[]>([])
  const [linkableLoading, setLinkableLoading] = useState(false)
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Set<string>>(new Set())
  const [linkingInvoices, setLinkingInvoices] = useState(false)
  const [unlinkingInvoiceId, setUnlinkingInvoiceId] = useState<string | null>(null)

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

  useEffect(() => {
    if (open && changeOrder) {
      void loadLinkedInvoices()
    } else if (!open) {
      setLinkedInvoices([])
      setLinkPickerOpen(false)
      setSelectedInvoiceIds(new Set())
    }
  }, [open, changeOrder, loadLinkedInvoices])

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
    if (!open) {
      setSignatureWizardOpen(false)
    }
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

  const totalCents = changeOrder.total_cents ?? changeOrder.totals?.total_cents ?? 0
  const isVoided = changeOrder.status === "cancelled"
  const isGmpProject = project ? resolveProjectBillingModel(project) === "cost_plus_gmp" : false
  const canApprove = changeOrder.status !== "approved" && !isVoided
  const canVoid = changeOrder.status === "approved"

  const handleApprove = async () => {
    if (!canApprove) return
    const confirmed = window.confirm(
      "Record this change order as approved without an Arc executed document? Use this only when the signed change-order document was completed outside Arc.",
    )
    if (!confirmed) return
    setApproving(true)
    try {
      const updated = await approveChangeOrderAction(changeOrder.id)
      onUpdate?.(updated)
      toast.success("Offline approval recorded", {
        description: "Use this only when the executed change-order document lives outside Arc.",
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

          {changeOrder.summary && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Notes</h4>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap">{changeOrder.summary}</p>
              </div>
            </div>
          )}

          {/* Description */}
          {changeOrder.description && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Scope & Notes</h4>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap">{changeOrder.description}</p>
              </div>
            </div>
          )}

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
                            {line.allowance_cents != null && line.allowance_cents > 0 ? (
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
                      {changeOrder.totals.allowance_cents != null && changeOrder.totals.allowance_cents > 0 ? (
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

          {/* Linked receivable invoices */}
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
                <div className="text-xs text-muted-foreground space-y-2 pt-2">
                  <div className="flex items-center gap-2">
                    <Clock className="h-3 w-3" />
                    <span>Created {formatDate(changeOrder.created_at)}</span>
                  </div>
                  {changeOrder.updated_at && changeOrder.updated_at !== changeOrder.created_at && (
                    <div className="flex items-center gap-2">
                      <Clock className="h-3 w-3" />
                      <span>Updated {formatDate(changeOrder.updated_at)}</span>
                    </div>
                  )}
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
              <div className="flex items-center gap-2">
                {canVoid ? (
                  <>
                    <Button
                      type="button"
                      onClick={() => onPrepareInvoice?.(changeOrder)}
                      disabled={!project || linkedInvoicesLoading || linkedInvoices.length > 0}
                      className="flex-1"
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
                    <Button
                      type="button"
                      onClick={() => setSignatureWizardOpen(true)}
                      className="flex-1"
                      disabled={!changeOrder.project_id}
                    >
                      Send for signature
                    </Button>
                    {canApprove ? (
                      <Button onClick={handleApprove} disabled={approving} variant="outline">
                        {approving ? "Recording..." : "Record offline approval"}
                      </Button>
                    ) : null}
                  </>
                )}
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Close
                </Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

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

      <EnvelopeWizard
        open={signatureWizardOpen}
        onOpenChange={setSignatureWizardOpen}
        sourceEntity={{
          type: "change_order",
          id: changeOrder.id,
          project_id: changeOrder.project_id,
          title: changeOrder.title,
          document_type: "change_order",
        }}
        sourceLabel="Change order"
        sheetTitle="Send change order for signature"
        onEnvelopeSent={({ documentId }) => {
          onUpdate?.({ ...changeOrder, esign_status: "sent", esign_document_id: documentId })
        }}
      />
    </>
  )
}
