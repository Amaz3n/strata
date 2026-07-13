"use client"

import { useState, useCallback, useEffect, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import { formatLocalDate } from "@/lib/utils"

import type { Company, Submittal, SubmittalItem, SubmittalReviewStep, Project } from "@/lib/types"
import type { SpecSectionOption } from "@/components/specs/types"
import { SubmittalReviewRail } from "@/components/submittals/submittal-review-rail"
import { unwrapAction } from "@/lib/action-result"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
} from "@/app/(app)/documents/actions"
import {
  addSubmittalItemAction,
  decideSubmittalAction,
  listSubmittalItemsAction,
  listSubmittalReviewStepsAction,
  listSubmittalRevisionsAction,
  resubmitSubmittalAction,
  updateSubmittalAction,
} from "@/app/(app)/submittals/actions"

const statusLabels: Record<string, string> = {
  draft: "Draft",
  pending: "Pending submission",
  submitted: "Submitted",
  in_review: "In Review",
  approved: "Approved",
  approved_as_noted: "Approved as Noted",
  revise_resubmit: "Revise & Resubmit",
  rejected: "Rejected",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  pending: "bg-muted text-muted-foreground border-muted",
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
  companies?: Company[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate?: (submittal: Submittal) => void
  specSections?: SpecSectionOption[]
}

export function SubmittalDetailSheet({
  submittal,
  project,
  companies = [],
  open,
  onOpenChange,
  onUpdate,
  specSections = [],
}: SubmittalDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [items, setItems] = useState<SubmittalItem[]>([])
  const [reviewSteps, setReviewSteps] = useState<SubmittalReviewStep[]>([])
  const [revisions, setRevisions] = useState<Submittal[]>([])
  const [decisionStatus, setDecisionStatus] = useState("approved")
  const [decisionNote, setDecisionNote] = useState("")
  const [itemForm, setItemForm] = useState({ description: "", manufacturer: "", model_number: "" })
  const [showItemForm, setShowItemForm] = useState(false)
  const [isPending, startTransition] = useTransition()

  const loadAttachments = useCallback(async () => {
    if (!submittal) return
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
    }
  }, [submittal])

  const loadItems = useCallback(async () => {
    if (!submittal) return
    try {
      setItems(await listSubmittalItemsAction(submittal.id))
    } catch (error) {
      console.error("Failed to load submittal items:", error)
      setItems([])
    }
  }, [submittal])

  const loadReviewSteps = useCallback(async () => {
    if (!submittal) return
    try {
      setReviewSteps(await listSubmittalReviewStepsAction(submittal.id))
    } catch (error) {
      console.error("Failed to load review steps:", error)
      setReviewSteps([])
    }
  }, [submittal])

  const loadRevisions = useCallback(async () => {
    if (!submittal) return
    try {
      const history = await listSubmittalRevisionsAction(submittal.project_id, submittal.submittal_number)
      setRevisions(history.filter((rev) => rev.id !== submittal.id))
    } catch (error) {
      console.error("Failed to load submittal revisions:", error)
      setRevisions([])
    }
  }, [submittal])

  useEffect(() => {
    if (open && submittal) {
      ;(async () => {
        if (submittal.attachment_file_id) {
          try {
            unwrapAction(await attachFileAction(
              submittal.attachment_file_id,
              "submittal",
              submittal.id,
              submittal.project_id,
              "legacy_attachment",
            ))
          } catch (error) {
            console.warn("Failed to backfill legacy submittal attachment link", error)
          }
        }
        await Promise.all([loadAttachments(), loadItems(), loadRevisions(), loadReviewSteps()])
      })()
    }
  }, [open, submittal, loadAttachments, loadItems, loadRevisions, loadReviewSteps])

  const handleAttach = useCallback(
    async (files: File[], linkRole?: string) => {
      if (!submittal) return

      for (const file of files) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("projectId", submittal.project_id)
        formData.append("category", "submittals")

        const uploaded = unwrapAction(await uploadFileAction(formData))
        unwrapAction(await attachFileAction(uploaded.id, "submittal", submittal.id, submittal.project_id, linkRole))
      }

      await loadAttachments()
    },
    [submittal, loadAttachments]
  )

  const handleDetach = useCallback(
    async (linkId: string) => {
      unwrapAction(await detachFileLinkAction(linkId))
      await loadAttachments()
    },
    [loadAttachments]
  )

  const handleDecision = () => {
    if (!submittal) return
    startTransition(async () => {
      try {
        const updated = unwrapAction(
          await decideSubmittalAction({
            submittal_id: submittal.id,
            decision_status: decisionStatus,
            decision_note: decisionNote.trim() || null,
          }),
        )
        onUpdate?.(updated)
        toast.success("Submittal decision recorded")
        setDecisionNote("")
      } catch (error) {
        toast.error("Failed to record decision", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const handleResubmit = () => {
    if (!submittal) return
    startTransition(async () => {
      try {
        const created = unwrapAction(await resubmitSubmittalAction(submittal.id))
        toast.success(`Revision ${created.revision} created`, {
          description: "The new revision is now the current submittal.",
        })
        onUpdate?.(created)
      } catch (error) {
        toast.error("Failed to create revision", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const handleAddItem = () => {
    if (!submittal) return
    if (!itemForm.description.trim()) {
      toast.error("Description required")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(
          await addSubmittalItemAction({
            submittal_id: submittal.id,
            description: itemForm.description.trim(),
            manufacturer: itemForm.manufacturer.trim() || undefined,
            model_number: itemForm.model_number.trim() || undefined,
          }),
        )
        setItemForm({ description: "", manufacturer: "", model_number: "" })
        setShowItemForm(false)
        toast.success("Item added")
        await loadItems()
      } catch (error) {
        toast.error("Failed to add item", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  if (!submittal) return null

  const formatDate = (date?: string | null) => {
    if (!date) return null
    if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return formatLocalDate(date, "MMM d, yyyy")
    }
    return format(new Date(date), "MMM d, yyyy")
  }

  const assignedCompanyName = companies.find((c) => c.id === submittal.assigned_company_id)?.name
  const isSuperseded = Boolean(submittal.superseded_by_id)
  const isDecided = Boolean(submittal.decision_status)
  const hasWorkflow = reviewSteps.length > 0
  // Days-in-court: since the current step took the ball (previous step's
  // return), or since the sub last submitted documents.
  const currentStep = reviewSteps.find((step) => step.status === "in_review")
  const courtSince = (() => {
    if (!currentStep) return submittal.last_item_submitted_at ?? submittal.submitted_at ?? null
    const prior = reviewSteps
      .filter((step) => step.status === "returned" && step.step_order < currentStep.step_order)
      .map((step) => step.decided_at)
      .filter(Boolean)
      .sort()
      .pop()
    return prior ?? submittal.last_item_submitted_at ?? submittal.submitted_at ?? null
  })()
  const daysInCourt =
    !isDecided && courtSince
      ? Math.max(0, Math.floor((Date.now() - new Date(courtSince).getTime()) / 86_400_000))
      : null
  const canResubmit =
    !isSuperseded && (submittal.decision_status === "revise_resubmit" || submittal.decision_status === "rejected")
  const stampedCopy = submittal.stamped_file_id
    ? attachments.find((attachment) => attachment.id === submittal.stamped_file_id)
    : undefined

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" mobileFullscreen className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] overflow-y-auto shadow-2xl">
        <SheetHeader>
          <div className="flex flex-wrap items-center gap-2">
            <FileText className="h-5 w-5 text-primary" />
            <SheetTitle>
              Submittal #{submittal.display_number ?? submittal.submittal_number}
              {submittal.revision > 0 ? ` · Rev ${submittal.revision}` : ""}
            </SheetTitle>
            <Button variant="ghost" size="sm" asChild><a href={`/projects/${submittal.project_id}/exports/submittal?id=${submittal.id}`} target="_blank" rel="noreferrer">PDF</a></Button>
            <Badge
              variant="secondary"
              className={`capitalize border ${statusStyles[submittal.status] ?? ""}`}
            >
              {statusLabels[submittal.status] ?? submittal.status}
            </Badge>
            {isSuperseded && (
              <Badge variant="outline" className="text-xs">Superseded</Badge>
            )}
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
            {(submittal.ball_in_court || assignedCompanyName) && !isDecided && (
              <Badge variant="outline" className="text-xs">
                Ball in court: {submittal.ball_in_court ?? assignedCompanyName}
                {daysInCourt != null ? ` · ${daysInCourt}d` : ""}
              </Badge>
            )}
            {submittal.due_date && (
              <div className="flex items-center gap-1">
                <Calendar className="h-4 w-4" />
                Review due {formatDate(submittal.due_date)}
              </div>
            )}
            {submittal.required_on_site && (
              <Badge variant="outline" className="text-xs">On site: {formatDate(submittal.required_on_site)}</Badge>
            )}
            {typeof submittal.lead_time_days === "number" && (
              <Badge variant="outline" className="text-xs">Lead time: {submittal.lead_time_days}d</Badge>
            )}
            {specSections.length ? (
              <Select
                value={submittal.spec_section_id ?? "__none__"}
                disabled={isPending}
                onValueChange={(value) => startTransition(async () => {
                  try {
                    const section = specSections.find((item) => item.id === value)
                    const updated = unwrapAction(await updateSubmittalAction({
                      submittal_id: submittal.id,
                      spec_section_id: value === "__none__" ? null : value,
                      spec_section: section?.section_number ?? null,
                    }))
                    onUpdate?.(updated)
                    toast.success("Spec section updated")
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : "Could not update spec section")
                  }
                })}
              >
                <SelectTrigger className="h-8 w-[260px]"><SelectValue placeholder="Spec section" /></SelectTrigger>
                <SelectContent><SelectItem value="__none__">No spec section</SelectItem>{specSections.map((section) => <SelectItem key={section.id} value={section.id}>{section.section_number} · {section.title}</SelectItem>)}</SelectContent>
              </Select>
            ) : submittal.spec_section ? (
              <div className="flex items-center gap-1">
                <Tag className="h-4 w-4" />
                Spec {submittal.spec_section}
              </div>
            ) : null}
            {submittal.submittal_type && (
              <Badge variant="outline" className="text-xs capitalize">
                {submittal.submittal_type.replace(/_/g, " ")}
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

          {/* Submitted items */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Submitted Items</h4>
              {!isSuperseded && (
                <Button variant="ghost" size="sm" onClick={() => setShowItemForm((v) => !v)}>
                  {showItemForm ? "Cancel" : "Add item"}
                </Button>
              )}
            </div>
            {items.length === 0 && !showItemForm ? (
              <p className="text-sm text-muted-foreground">Nothing submitted yet.</p>
            ) : (
              <div className="space-y-2">
                {items.map((item) => (
                  <div key={item.id} className="rounded-lg border p-3 space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span>#{item.item_number}</span>
                        {item.created_via_portal ? (
                          <Badge variant="outline" className="text-[10px]">via portal</Badge>
                        ) : null}
                        {item.responder_name ? <span>{item.responder_name}</span> : null}
                      </div>
                      <span>{formatDate(item.created_at)}</span>
                    </div>
                    <p className="text-sm">{item.description}</p>
                    {(item.manufacturer || item.model_number) && (
                      <p className="text-xs text-muted-foreground">
                        {[item.manufacturer, item.model_number].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {item.file_name && (
                      <p className="text-xs text-muted-foreground">Attached: {item.file_name}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
            {showItemForm && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <Input
                  placeholder="Item description (e.g. Trane XR14 condenser data sheet)"
                  value={itemForm.description}
                  onChange={(e) => setItemForm((prev) => ({ ...prev, description: e.target.value }))}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    placeholder="Manufacturer"
                    value={itemForm.manufacturer}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, manufacturer: e.target.value }))}
                  />
                  <Input
                    placeholder="Model number"
                    value={itemForm.model_number}
                    onChange={(e) => setItemForm((prev) => ({ ...prev, model_number: e.target.value }))}
                  />
                </div>
                <Button size="sm" onClick={handleAddItem} disabled={isPending} className="w-full">
                  {isPending ? "Adding..." : "Add item"}
                </Button>
              </div>
            )}
          </div>

          {/* Multi-step review workflow (commercial routing) */}
          {hasWorkflow && !isSuperseded && (
            <SubmittalReviewRail
              submittal={submittal}
              steps={reviewSteps}
              onStepsChange={setReviewSteps}
              onSubmittalUpdate={onUpdate}
            />
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
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{submittal.decision_note}</p>
                )}
                {submittal.decision_at && (
                  <p className="text-xs text-muted-foreground">
                    Reviewed {formatDate(submittal.decision_at)}
                  </p>
                )}
                {stampedCopy?.download_url && (
                  <a
                    className="block text-xs font-medium text-primary underline underline-offset-2"
                    href={stampedCopy.download_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download stamped copy
                  </a>
                )}
                {canResubmit && (
                  <Button variant="outline" size="sm" onClick={handleResubmit} disabled={isPending}>
                    {isPending ? "Creating..." : `Resubmit as Rev ${submittal.revision + 1}`}
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Record decision — only for undecided, current revisions without a
              routed workflow (routed submittals decide step by step above) */}
          {!isDecided && !isSuperseded && !hasWorkflow && (
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Record Decision</h4>
              <div className="rounded-lg border p-4 space-y-3">
                <Select value={decisionStatus} onValueChange={setDecisionStatus}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select decision" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="approved_as_noted">Approved as Noted</SelectItem>
                    <SelectItem value="revise_resubmit">Revise & Resubmit</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
                <Textarea
                  value={decisionNote}
                  onChange={(event) => setDecisionNote(event.target.value)}
                  placeholder="Reviewer notes, exceptions, or resubmission instructions"
                  rows={3}
                />
                <Button onClick={handleDecision} disabled={isPending} className="w-full">
                  {isPending ? "Saving..." : "Save decision"}
                </Button>
              </div>
            </div>
          )}

          {/* Revision history */}
          {revisions.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Revision History</h4>
              <div className="space-y-1">
                {revisions.map((rev) => (
                  <div key={rev.id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                    <span>Rev {rev.revision}</span>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="secondary"
                        className={`text-[10px] capitalize border ${statusStyles[rev.status] ?? ""}`}
                      >
                        {statusLabels[rev.status] ?? rev.status}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{formatDate(rev.created_at)}</span>
                    </div>
                  </div>
                ))}
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
            {submittal.submitted_at && (
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                Submitted {formatDate(submittal.submitted_at)}
              </div>
            )}
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
