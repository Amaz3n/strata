"use client"

import { useState, useCallback, useEffect } from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import type { Rfi, Project } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Calendar, Building2, FileText, User, Clock, MessageSquare, CheckCircle } from "@/components/icons"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { LinkedDrawings } from "@/components/drawings"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/files/actions"
import { addRfiResponseAction, decideRfiAction } from "@/app/(app)/rfis/actions"
import { rfiResponseInputSchema, rfiDecisionSchema, type RfiResponseInput, type RfiDecisionInput } from "@/lib/validation/rfis"

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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showResponseForm, setShowResponseForm] = useState(false)

  const responseForm = useForm<RfiResponseInput>({
    resolver: zodResolver(rfiResponseInputSchema),
    defaultValues: {
      rfi_id: rfi?.id ?? "",
      body: "",
      response_type: "comment",
      created_via_portal: false,
    },
  })

  const decisionForm = useForm<RfiDecisionInput>({
    resolver: zodResolver(rfiDecisionSchema),
    defaultValues: {
      rfi_id: rfi?.id ?? "",
      decision_status: "approved",
      decision_note: "",
    },
  })

  // Update form when RFI changes
  useEffect(() => {
    if (rfi) {
      responseForm.reset({
        rfi_id: rfi.id,
        body: "",
        response_type: "comment",
        created_via_portal: false,
      })
      decisionForm.reset({
        rfi_id: rfi.id,
        decision_status: "approved",
        decision_note: "",
      })
    }
  }, [rfi, responseForm, decisionForm])

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
  }, [rfi])

  // Load attachments when sheet opens
  useEffect(() => {
    if (open && rfi) {
      ;(async () => {
        if (rfi.attachment_file_id) {
          try {
            await attachFileAction(
              rfi.attachment_file_id,
              "rfi",
              rfi.id,
              rfi.project_id,
              "legacy_attachment",
            )
          } catch (error) {
            console.warn("Failed to backfill legacy RFI attachment link", error)
          }
        }
        await loadAttachments()
      })()
    }
  }, [open, rfi, loadAttachments])

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

  const handleSubmitResponse = async (values: RfiResponseInput) => {
    if (!rfi) return

    setIsSubmitting(true)
    try {
      await addRfiResponseAction(values)
      toast.success("Response added", { description: "Your response has been recorded." })
      setShowResponseForm(false)
      responseForm.reset()
      onUpdate?.(rfi) // Trigger parent update
    } catch (error: any) {
      console.error("Failed to add response:", error)
      toast.error("Failed to add response", { description: error?.message ?? "Please try again." })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSubmitDecision = async (values: RfiDecisionInput) => {
    if (!rfi) return

    setIsSubmitting(true)
    try {
      await decideRfiAction(values)
      toast.success("Decision recorded", { description: "The RFI decision has been recorded." })
      onUpdate?.(rfi) // Trigger parent update
    } catch (error: any) {
      console.error("Failed to record decision:", error)
      toast.error("Failed to record decision", { description: error?.message ?? "Please try again." })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!rfi) return null

  const formatDate = (date?: string | null) => {
    if (!date) return null
    return format(new Date(date), "MMM d, yyyy")
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{
          animationDuration: '150ms',
          transitionDuration: '150ms'
        } as React.CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
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

        <ScrollArea className="flex-1">
          <div className="px-6 py-4 space-y-6">
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

          {/* Response Section */}
          {rfi.status !== "closed" && (
            <div className="space-y-4">
              {!showResponseForm ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setShowResponseForm(true)}
                    className="flex-1"
                  >
                    <MessageSquare className="h-4 w-4 mr-2" />
                    Add Response
                  </Button>
                  {rfi.status === "open" && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => handleSubmitDecision({
                        rfi_id: rfi.id,
                        decision_status: "approved",
                        decision_note: "Approved without additional response."
                      })}
                      disabled={isSubmitting}
                    >
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Quick Approve
                    </Button>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium">Add Response</h4>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowResponseForm(false)}
                    >
                      Cancel
                    </Button>
                  </div>

                  <Form {...responseForm}>
                    <form onSubmit={responseForm.handleSubmit(handleSubmitResponse)} className="space-y-4">
                      <FormField
                        control={responseForm.control}
                        name="response_type"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Response Type</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger className="h-8">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="comment">Comment</SelectItem>
                                <SelectItem value="clarification">Clarification</SelectItem>
                                <SelectItem value="answer">Answer (marks as answered)</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={responseForm.control}
                        name="body"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Response</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder="Provide your response to this RFI..."
                                className="min-h-[80px] resize-none"
                                {...field}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <Button type="submit" size="sm" disabled={isSubmitting} className="w-full">
                        {isSubmitting ? "Submitting..." : "Submit Response"}
                      </Button>
                    </form>
                  </Form>
                </div>
              )}

              {/* Decision Options for answered RFIs */}
              {rfi.status === "answered" && !rfi.decision_status && (
                <div className="rounded-lg border bg-blue-50/50 dark:bg-blue-900/10 p-4 space-y-4">
                  <h4 className="text-sm font-medium text-blue-900 dark:text-blue-100">
                    Record Final Decision
                  </h4>

                  <Form {...decisionForm}>
                    <form onSubmit={decisionForm.handleSubmit(handleSubmitDecision)} className="space-y-4">
                      <FormField
                        control={decisionForm.control}
                        name="decision_status"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Decision</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger className="h-8">
                                  <SelectValue />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                <SelectItem value="approved">Approved</SelectItem>
                                <SelectItem value="revisions_requested">Revisions Requested</SelectItem>
                                <SelectItem value="rejected">Rejected</SelectItem>
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={decisionForm.control}
                        name="decision_note"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="text-xs">Decision Note (optional)</FormLabel>
                            <FormControl>
                              <Textarea
                                placeholder="Add any notes about this decision..."
                                className="min-h-[60px] resize-none"
                                {...field}
                                value={field.value || ""}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <Button type="submit" size="sm" disabled={isSubmitting} className="w-full">
                        {isSubmitting ? "Recording..." : "Record Decision"}
                      </Button>
                    </form>
                  </Form>
                </div>
              )}
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

          <LinkedDrawings projectId={rfi.project_id} entityType="rfi" entityId={rfi.id} />

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
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
