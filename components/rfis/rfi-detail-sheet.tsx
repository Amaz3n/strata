"use client"

import { useState, useCallback, useEffect } from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import type { Company, Contact, Rfi, Project, RfiResponse } from "@/lib/types"
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
import { addRfiResponseAction, decideRfiAction, listRfiResponsesAction, sendRfiAction } from "@/app/(app)/rfis/actions"
import { rfiResponseInputSchema, rfiDecisionSchema, type RfiResponseInput, type RfiDecisionInput } from "@/lib/validation/rfis"

const statusLabels: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  answered: "Answered",
  closed: "Closed",
}

const statusStyles: Record<string, string> = {
  draft: "bg-zinc-500/15 text-zinc-600 border-zinc-500/30",
  open: "bg-warning/20 text-warning border-warning/40",
  answered: "bg-success/20 text-success border-success/30",
  closed: "bg-muted text-muted-foreground border-muted",
}

interface RfiDetailSheetProps {
  rfi: Rfi | null
  project?: Project
  companies?: Company[]
  contacts?: Contact[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate?: () => void
}

export function RfiDetailSheet({
  rfi,
  project,
  companies = [],
  contacts = [],
  open,
  onOpenChange,
  onUpdate,
}: RfiDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isLoadingAttachments, setIsLoadingAttachments] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showResponseForm, setShowResponseForm] = useState(false)
  const [responses, setResponses] = useState<RfiResponse[]>([])
  const [isLoadingResponses, setIsLoadingResponses] = useState(false)

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

  const loadResponses = useCallback(async () => {
    if (!rfi) return
    setIsLoadingResponses(true)
    try {
      const data = await listRfiResponsesAction(rfi.id)
      setResponses(data)
    } catch (error) {
      console.error("Failed to load RFI responses:", error)
      setResponses([])
    } finally {
      setIsLoadingResponses(false)
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
        await Promise.all([loadAttachments(), loadResponses()])
      })()
    }
  }, [open, rfi, loadAttachments, loadResponses])

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
      await Promise.all([loadResponses(), onUpdate?.()])
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
      await onUpdate?.()
    } catch (error: any) {
      console.error("Failed to record decision:", error)
      toast.error("Failed to record decision", { description: error?.message ?? "Please try again." })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSendDraft = async () => {
    if (!rfi) return
    setIsSubmitting(true)
    try {
      await sendRfiAction(rfi.id)
      toast.success("RFI sent", { description: "Portal and email notifications were sent." })
      await onUpdate?.()
    } catch (error: any) {
      console.error("Failed to send RFI:", error)
      toast.error("Failed to send RFI", { description: error?.message ?? "Please try again." })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!rfi) return null

  const formatDate = (date?: string | null) => {
    if (!date) return null
    return format(new Date(date), "MMM d, yyyy")
  }

  const assignedCompanyName = companies.find((company) => company.id === rfi.assigned_company_id)?.name
  const notifyContact = contacts.find((contact) => contact.id === rfi.notify_contact_id)
  const sentToEmails = rfi.sent_to_emails ?? []

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
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
            {rfi.location && (
              <Badge variant="outline" className="text-xs">Location: {rfi.location}</Badge>
            )}
            {rfi.drawing_reference && (
              <Badge variant="outline" className="text-xs">Drawing: {rfi.drawing_reference}</Badge>
            )}
            {rfi.spec_reference && (
              <Badge variant="outline" className="text-xs">Spec: {rfi.spec_reference}</Badge>
            )}
            {typeof rfi.schedule_impact_days === "number" && (
              <Badge variant="outline" className="text-xs">Schedule impact: {rfi.schedule_impact_days}d</Badge>
            )}
            {typeof rfi.cost_impact_cents === "number" && (
              <Badge variant="outline" className="text-xs">Cost impact: ${(rfi.cost_impact_cents / 100).toLocaleString()}</Badge>
            )}
          </div>

          <div className="rounded-lg border bg-muted/20 p-3 space-y-2">
            <h4 className="text-sm font-medium">Delivery</h4>
            <div className="text-sm text-muted-foreground space-y-1">
              <p>{rfi.submitted_at ? `Sent ${formatDate(rfi.submitted_at)}` : "Not sent yet"}</p>
              {rfi.answered_at ? <p>Answered {formatDate(rfi.answered_at)}</p> : null}
              {assignedCompanyName ? <p>Assigned company: {assignedCompanyName}</p> : null}
              {notifyContact ? <p>Notify contact: {notifyContact.full_name}{notifyContact.email ? ` (${notifyContact.email})` : ""}</p> : null}
              {sentToEmails.length > 0 ? (
                <p className="break-all">Recipients: {sentToEmails.join(", ")}</p>
              ) : null}
            </div>
            {rfi.status === "draft" ? (
              <Button size="sm" onClick={handleSendDraft} disabled={isSubmitting}>
                {isSubmitting ? "Sending..." : "Send Now"}
              </Button>
            ) : null}
          </div>

          <Separator />

          {/* Question */}
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Question</h4>
            <div className="rounded-lg border bg-muted/30 p-4">
              <p className="text-sm whitespace-pre-wrap">{rfi.question}</p>
            </div>
          </div>

          {/* Response thread */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium">Responses</h4>
              {rfi.answered_at && (
                <span className="text-xs text-muted-foreground">Answered {formatDate(rfi.answered_at)}</span>
              )}
            </div>
            <div className="space-y-2">
              {isLoadingResponses ? (
                <p className="text-sm text-muted-foreground">Loading responses...</p>
              ) : responses.length === 0 ? (
                <p className="text-sm text-muted-foreground">No responses yet.</p>
              ) : (
                responses.map((response) => (
                  <div key={response.id} className="rounded-lg border p-3 space-y-1">
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <span className="capitalize">{response.response_type}</span>
                        {response.created_via_portal ? (
                          <Badge variant="outline" className="text-[10px]">via portal</Badge>
                        ) : null}
                        {response.responder_name ? (
                          <span>{response.responder_name}</span>
                        ) : null}
                      </div>
                      <span>{formatDate(response.created_at)}</span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{response.body}</p>
                  </div>
                ))
              )}
            </div>
          </div>

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
