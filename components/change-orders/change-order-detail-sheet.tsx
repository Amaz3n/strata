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
import { Separator } from "@/components/ui/separator"
import { Calendar, Building2, DollarSign, Clock, FileText } from "@/components/icons"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/files/actions"

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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <SheetTitle>
              Change Order
            </SheetTitle>
            <Badge
              variant="secondary"
              className={`capitalize border ${statusStyles[changeOrder.status] ?? ""}`}
            >
              {statusLabels[changeOrder.status] ?? changeOrder.status}
            </Badge>
          </div>
          <SheetDescription className="text-left">
            {changeOrder.title}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {/* Meta info */}
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            {project && (
              <div className="flex items-center gap-1">
                <Building2 className="h-4 w-4" />
                {project.name}
              </div>
            )}
            <div className="flex items-center gap-1">
              <DollarSign className="h-4 w-4" />
              <span className="font-semibold text-foreground">
                {formatMoney(totalCents)}
              </span>
            </div>
            {changeOrder.days_impact != null && changeOrder.days_impact > 0 && (
              <Badge variant="outline" className="text-xs">
                +{changeOrder.days_impact} days impact
              </Badge>
            )}
          </div>

          <Separator />

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
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Line Items</h4>
              <div className="rounded-lg border divide-y">
                {changeOrder.lines.map((line, idx) => (
                  <div key={line.id ?? idx} className="p-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm">{line.description}</p>
                      <p className="text-xs text-muted-foreground">
                        {line.quantity} {line.unit ?? "units"} @ {formatMoney(line.unit_cost_cents)}
                      </p>
                    </div>
                    <span className="font-medium text-sm">
                      {formatMoney(line.quantity * (line.unit_cost_cents ?? 0))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Totals */}
          {changeOrder.totals && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Totals</h4>
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatMoney(changeOrder.totals.subtotal_cents)}</span>
                </div>
                {changeOrder.totals.allowance_cents != null && changeOrder.totals.allowance_cents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Allowances</span>
                    <span>{formatMoney(changeOrder.totals.allowance_cents)}</span>
                  </div>
                )}
                {changeOrder.totals.markup_cents != null && changeOrder.totals.markup_cents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Markup ({changeOrder.totals.markup_percent ?? 0}%)
                    </span>
                    <span>{formatMoney(changeOrder.totals.markup_cents)}</span>
                  </div>
                )}
                {changeOrder.totals.tax_cents != null && changeOrder.totals.tax_cents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">
                      Tax ({changeOrder.totals.tax_rate ?? 0}%)
                    </span>
                    <span>{formatMoney(changeOrder.totals.tax_cents)}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span>{formatMoney(changeOrder.totals.total_cents)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Approval info */}
          {changeOrder.approved_at && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Approval</h4>
              <div className="rounded-lg border bg-success/5 border-success/20 p-4 space-y-1">
                <Badge variant="default">Approved</Badge>
                <p className="text-xs text-muted-foreground">
                  Approved {formatDate(changeOrder.approved_at)}
                </p>
              </div>
            </div>
          )}

          <Separator />

          {/* Attachments */}
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

          {/* Timestamps */}
          <div className="text-xs text-muted-foreground space-y-1 pt-4 border-t">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Created {formatDate(changeOrder.created_at)}
            </div>
            {changeOrder.updated_at && changeOrder.updated_at !== changeOrder.created_at && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Updated {formatDate(changeOrder.updated_at)}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
