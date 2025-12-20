"use client"

import { useState, useCallback, useEffect } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Rfi, Project } from "@/lib/types"
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
import { Calendar, Building2, FileText, User, Clock } from "@/components/icons"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/files/actions"

const statusLabels: Record<string, string> = {
  open: "Open",
  in_review: "In review",
  answered: "Answered",
  closed: "Closed",
}

const statusStyles: Record<string, string> = {
  open: "bg-warning/20 text-warning border-warning/40",
  in_review: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  answered: "bg-success/20 text-success border-success/30",
  closed: "bg-muted text-muted-foreground border-muted",
}

interface RfiDetailSheetProps {
  rfi: Rfi | null
  project?: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate?: (rfi: Rfi) => void
}

export function RfiDetailSheet({
  rfi,
  project,
  open,
  onOpenChange,
  onUpdate,
}: RfiDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false)

  // Load attachments when sheet opens
  useEffect(() => {
    if (open && rfi) {
      loadAttachments()
    }
  }, [open, rfi?.id])

  const loadAttachments = useCallback(async () => {
    if (!rfi) return

    setIsLoadingAttachments(true)
    try {
      const links = await listAttachmentsAction("rfi", rfi.id)
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
  }, [rfi?.id])

  const handleAttach = useCallback(
    async (files: File[], linkRole?: string) => {
      if (!rfi) return

      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", rfi.project_id)
        formData.append("category", "rfis")

        const uploaded = await uploadFileAction(formData)
        await attachFileAction(uploaded.id, "rfi", rfi.id, rfi.project_id, linkRole)
      }

      await loadAttachments()
    },
    [rfi, loadAttachments]
  )

  const handleDetach = useCallback(
    async (linkId: string) => {
      await detachFileLinkAction(linkId)
      await loadAttachments()
    },
    [loadAttachments]
  )

  if (!rfi) return null

  const formatDate = (date?: string | null) => {
    if (!date) return null
    return format(new Date(date), "MMM d, yyyy")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-xl w-full overflow-y-auto">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <SheetTitle>
              RFI #{rfi.rfi_number}
            </SheetTitle>
            <Badge
              variant="secondary"
              className={`capitalize border ${statusStyles[rfi.status] ?? ""}`}
            >
              {statusLabels[rfi.status] ?? rfi.status}
            </Badge>
          </div>
          <SheetDescription className="text-left">
            {rfi.subject}
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
            {rfi.due_date && (
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                Due {formatDate(rfi.due_date)}
              </div>
            )}
            {rfi.priority && (
              <Badge variant="outline" className="text-xs">
                {rfi.priority} priority
              </Badge>
            )}
          </div>

          <Separator />

          {/* Question */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Question</h4>
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-sm whitespace-pre-wrap">{rfi.question}</p>
            </div>
          </div>

          {/* Answer (if answered) */}
          {rfi.answered_at && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Response</h4>
                <span className="text-xs text-muted-foreground">
                  Answered {formatDate(rfi.answered_at)}
                </span>
              </div>
              <div className="rounded-lg border bg-success/5 border-success/20 p-4">
                <p className="text-sm">
                  {/* Response would go here if tracked */}
                  Response recorded
                </p>
              </div>
            </div>
          )}

          {/* Decision info */}
          {rfi.decision_status && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Decision</h4>
              <div className="rounded-lg border p-4 space-y-2">
                <Badge
                  variant={
                    rfi.decision_status === "approved"
                      ? "default"
                      : rfi.decision_status === "rejected"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {rfi.decision_status.replace("_", " ")}
                </Badge>
                {rfi.decision_note && (
                  <p className="text-sm text-muted-foreground">{rfi.decision_note}</p>
                )}
                {rfi.decided_at && (
                  <p className="text-xs text-muted-foreground">
                    Decided {formatDate(rfi.decided_at)}
                  </p>
                )}
              </div>
            </div>
          )}

          <Separator />

          {/* Attachments */}
          <EntityAttachments
            entityType="rfi"
            entityId={rfi.id}
            projectId={rfi.project_id}
            attachments={attachments}
            onAttach={handleAttach}
            onDetach={handleDetach}
            title="Attachments"
            description="Supporting documents, drawings, or photos for this RFI"
          />

          {/* Timestamps */}
          <div className="text-xs text-muted-foreground space-y-1 pt-4 border-t">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Created {formatDate(rfi.created_at)}
            </div>
            {rfi.last_response_at && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Last response {formatDate(rfi.last_response_at)}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
