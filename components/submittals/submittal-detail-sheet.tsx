"use client"

import { useState, useCallback, useEffect } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Submittal, Project } from "@/lib/types"
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
import { Calendar, Building2, FileText, Clock, Tag } from "@/components/icons"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { LinkedDrawings } from "@/components/drawings"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/files/actions"

const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  in_review: "In Review",
  approved: "Approved",
  approved_as_noted: "Approved as Noted",
  revise_resubmit: "Revise & Resubmit",
  rejected: "Rejected",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  submitted: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  in_review: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  approved_as_noted: "bg-success/15 text-success border-success/25",
  revise_resubmit: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
}

interface SubmittalDetailSheetProps {
  submittal: Submittal | null
  project?: Project
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate?: (submittal: Submittal) => void
}

export function SubmittalDetailSheet({
  submittal,
  project,
  open,
  onOpenChange,
  onUpdate,
}: SubmittalDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false)

  const loadAttachments = useCallback(async () => {
    if (!submittal) return

    setIsLoadingAttachments(true)
    try {
      const links = await listAttachmentsAction("submittal", submittal.id)
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
  }, [submittal])

  // Load attachments when sheet opens
  useEffect(() => {
    if (open && submittal) {
      ;(async () => {
        if (submittal.attachment_file_id) {
          try {
            await attachFileAction(
              submittal.attachment_file_id,
              "submittal",
              submittal.id,
              submittal.project_id,
              "legacy_attachment",
            )
          } catch (error) {
            console.warn("Failed to backfill legacy submittal attachment link", error)
          }
        }
        await loadAttachments()
      })()
    }
  }, [open, submittal, loadAttachments])

  const handleAttach = useCallback(
    async (files: File[], linkRole?: string) => {
      if (!submittal) return

      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", submittal.project_id)
        formData.append("category", "submittals")

        const uploaded = await uploadFileAction(formData)
        await attachFileAction(uploaded.id, "submittal", submittal.id, submittal.project_id, linkRole)
      }

      await loadAttachments()
    },
    [submittal, loadAttachments]
  )

  const handleDetach = useCallback(
    async (linkId: string) => {
      await detachFileLinkAction(linkId)
      await loadAttachments()
    },
    [loadAttachments]
  )

  if (!submittal) return null

  const formatDate = (date?: string | null) => {
    if (!date) return null
    return format(new Date(date), "MMM d, yyyy")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <SheetTitle>
              Submittal #{submittal.submittal_number}
            </SheetTitle>
            <Badge
              variant="secondary"
              className={`capitalize border ${statusStyles[submittal.status] ?? ""}`}
            >
              {statusLabels[submittal.status] ?? submittal.status}
            </Badge>
          </div>
          <SheetDescription className="text-left">
            {submittal.title}
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
            {submittal.due_date && (
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                Due {formatDate(submittal.due_date)}
              </div>
            )}
            {submittal.spec_section && (
              <div className="flex items-center gap-1">
                <Tag className="h-4 w-4" />
                Spec {submittal.spec_section}
              </div>
            )}
            {submittal.submittal_type && (
              <Badge variant="outline" className="text-xs">
                {submittal.submittal_type}
              </Badge>
            )}
          </div>

          <Separator />

          {/* Description */}
          {submittal.description && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Description</h4>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap">{submittal.description}</p>
              </div>
            </div>
          )}

          {/* Decision info */}
          {submittal.decision_status && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Review Decision</h4>
              <div className="rounded-lg border p-4 space-y-2">
                <Badge
                  variant={
                    submittal.decision_status === "approved" || submittal.decision_status === "approved_as_noted"
                      ? "default"
                      : submittal.decision_status === "rejected"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {submittal.decision_status.replace(/_/g, " ")}
                </Badge>
                {submittal.decision_note && (
                  <p className="text-sm text-muted-foreground">{submittal.decision_note}</p>
                )}
                {submittal.decision_at && (
                  <p className="text-xs text-muted-foreground">
                    Reviewed {formatDate(submittal.decision_at)}
                  </p>
                )}
              </div>
            </div>
          )}

          <Separator />

          {/* Attachments */}
          <EntityAttachments
            entityType="submittal"
            entityId={submittal.id}
            projectId={submittal.project_id}
            attachments={attachments}
            onAttach={handleAttach}
            onDetach={handleDetach}
            title="Submittal Package"
            description="Shop drawings, product data, samples, or other submittal documents"
          />

          <LinkedDrawings projectId={submittal.project_id} entityType="submittal" entityId={submittal.id} />

          {/* Timestamps */}
          <div className="text-xs text-muted-foreground space-y-1 pt-4 border-t">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Created {formatDate(submittal.created_at)}
            </div>
            {submittal.reviewed_at && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Reviewed {formatDate(submittal.reviewed_at)}
              </div>
            )}
            {submittal.last_item_submitted_at && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Last submission {formatDate(submittal.last_item_submitted_at)}
              </div>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
