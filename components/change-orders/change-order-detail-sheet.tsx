"use client"

import { useState, useCallback, useEffect } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { ChangeOrder, Project } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Calendar, Building2, DollarSign, Clock, FileText, Sparkles } from "@/components/icons"
import { approveChangeOrderAction } from "@/app/(app)/change-orders/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/files/actions"

const statusLabels: Record<string, string> = {
  draft: "Draft",
  pending: "Pending Approval",
  approved: "Approved",
  rejected: "Rejected",
  void: "Void",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  pending: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  void: "bg-muted text-muted-foreground border-muted",
}

interface ChangeOrderDetailSheetProps {
  changeOrder: ChangeOrder | null
  project?: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate?: (changeOrder: ChangeOrder) => void
}

function formatMoney(cents?: number | null) {
  if (cents == null) return "$0.00"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

export function ChangeOrderDetailSheet({
  changeOrder,
  project,
  open,
  onOpenChange,
  onUpdate,
}: ChangeOrderDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false)
  const [approving, setApproving] = useState(false)

  // Load attachments when sheet opens
  useEffect(() => {
    if (open && changeOrder) {
      loadAttachments()
    }
  }, [open, changeOrder?.id])

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
  }, [changeOrder?.id])

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
  const canApprove = changeOrder.status !== "approved"

  const handleApprove = async () => {
    if (!canApprove) return
    setApproving(true)
    try {
      const updated = await approveChangeOrderAction(changeOrder.id)
      onUpdate?.(updated)
      toast.success("Change order approved")
    } catch (error: any) {
      toast.error("Failed to approve", { description: error?.message ?? "Please try again." })
    } finally {
      setApproving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation [&>button]:hidden"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <SheetTitle className="flex-1">
              {changeOrder.title}
            </SheetTitle>
            <Badge
              variant="secondary"
              className={`capitalize border ${statusStyles[changeOrder.status] ?? ""}`}
            >
              {statusLabels[changeOrder.status] ?? changeOrder.status}
            </Badge>
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 py-4 space-y-6">

          {/* Summary */}
          {changeOrder.summary && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Summary</h4>
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

          {/* Line items */}
          {changeOrder.lines && changeOrder.lines.length > 0 && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Line Items</h4>
              <div className="space-y-2">
                {changeOrder.lines.map((line, idx) => {
                  const lineTotal = (line.quantity ?? 1) * (line.unit_cost_cents ?? 0) + (line.allowance_cents ?? 0)
                  return (
                    <div key={line.id ?? idx} className="rounded-lg border p-4 bg-muted/30">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 space-y-1">
                          <p className="text-sm font-medium">{line.description}</p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>{line.quantity} {line.unit ?? "units"}</span>
                            {line.unit_cost_cents && (
                              <>
                                <span>@</span>
                                <span>{formatMoney(line.unit_cost_cents)}</span>
                              </>
                            )}
                            {line.allowance_cents && line.allowance_cents > 0 && (
                              <>
                                <span>+</span>
                                <span>Allowance: {formatMoney(line.allowance_cents)}</span>
                              </>
                            )}
                            {line.taxable && (
                              <Badge variant="outline" className="text-xs">Taxable</Badge>
                            )}
                          </div>
                        </div>
                        <span className="font-semibold text-sm">
                          {formatMoney(lineTotal)}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Totals */}
          {changeOrder.totals && (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold">Totals</h4>
              <div className="rounded-lg border bg-muted/40 p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span className="font-medium">{formatMoney(changeOrder.totals.subtotal_cents)}</span>
                </div>
                {changeOrder.totals.allowance_cents != null && changeOrder.totals.allowance_cents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Allowances</span>
                    <span className="font-medium">{formatMoney(changeOrder.totals.allowance_cents)}</span>
                  </div>
                )}
                {changeOrder.totals.markup_cents != null && changeOrder.totals.markup_cents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Markup ({changeOrder.totals.markup_percent ?? 0}%)
                    </span>
                    <span className="font-medium">{formatMoney(changeOrder.totals.markup_cents)}</span>
                  </div>
                )}
                {changeOrder.totals.tax_cents != null && changeOrder.totals.tax_cents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Tax ({changeOrder.totals.tax_rate ?? 0}%)
                    </span>
                    <span className="font-medium">{formatMoney(changeOrder.totals.tax_cents)}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-semibold text-base">
                  <span>Total</span>
                  <span>{formatMoney(changeOrder.totals.total_cents)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Approval info */}
          {(changeOrder.approved_at || (changeOrder.days_impact != null && changeOrder.days_impact > 0)) && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Approval</h4>
              <div className="rounded-lg border bg-success/5 border-success/20 p-4 space-y-2">
                {changeOrder.approved_at && (
                  <>
                    <Badge variant="default">Approved</Badge>
                    <p className="text-xs text-muted-foreground">
                      Approved {formatDate(changeOrder.approved_at)}
                    </p>
                  </>
                )}
                {changeOrder.days_impact != null && changeOrder.days_impact > 0 && (
                  <Badge variant="outline" className="text-xs">
                    +{changeOrder.days_impact} days impact
                  </Badge>
                )}
              </div>
            </div>
          )}

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
          <div className="flex gap-2">
            {canApprove && (
              <Button onClick={handleApprove} disabled={approving} className="flex-1">
                {approving ? "Approving..." : "Mark approved"}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className={canApprove ? "flex-1" : "w-full"}
            >
              Close
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
