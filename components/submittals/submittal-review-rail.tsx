"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import type { Contact, Submittal, SubmittalReviewStep } from "@/lib/types"
import { unwrapAction } from "@/lib/action-result"
import { formatLocalDate } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CheckCircle2, Circle, Clock } from "@/components/icons"
import {
  decideSubmittalReviewStepAction,
  listSubmittalReviewStepsAction,
  updateSubmittalReviewStepAction,
} from "@/app/(app)/submittals/actions"
import { listContactsAction } from "@/app/(app)/contacts/actions"

const stepStatusStyles: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border-muted",
  in_review: "bg-warning/20 text-warning border-warning/40",
  returned: "bg-success/15 text-success border-success/25",
  skipped: "bg-muted text-muted-foreground border-muted",
}

const decisionLabels: Record<string, string> = {
  approved: "Approved",
  approved_as_noted: "Approved as Noted",
  revise_resubmit: "Revise & Resubmit",
  rejected: "Rejected",
}

interface SubmittalReviewRailProps {
  submittal: Submittal
  steps: SubmittalReviewStep[]
  onStepsChange: (steps: SubmittalReviewStep[]) => void
  onSubmittalUpdate?: (submittal: Submittal) => void
}

export function SubmittalReviewRail({
  submittal,
  steps,
  onStepsChange,
  onSubmittalUpdate,
}: SubmittalReviewRailProps) {
  const [decision, setDecision] = useState("approved")
  const [notes, setNotes] = useState("")
  const [assigningStepId, setAssigningStepId] = useState<string | null>(null)
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [isPending, startTransition] = useTransition()

  const currentStep = steps.find((step) => step.status === "in_review") ?? null

  useEffect(() => {
    if (!assigningStepId || contacts !== null) return
    listContactsAction()
      .then((rows) => setContacts(rows.filter((contact: Contact) => !!contact.full_name)))
      .catch(() => setContacts([]))
  }, [assigningStepId, contacts])

  const reloadSteps = async () => {
    try {
      onStepsChange(await listSubmittalReviewStepsAction(submittal.id))
    } catch (error) {
      console.error("Failed to reload review steps", error)
    }
  }

  const handleDecide = () => {
    if (!currentStep) return
    startTransition(async () => {
      try {
        const updated = unwrapAction(
          await decideSubmittalReviewStepAction({
            step_id: currentStep.id,
            decision,
            notes: notes.trim() || null,
          }),
        )
        onSubmittalUpdate?.(updated)
        setNotes("")
        toast.success("Step decision recorded")
        await reloadSteps()
      } catch (error) {
        toast.error("Failed to record step decision", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const handleAssign = (stepId: string, contactId: string) => {
    const contact = contacts?.find((candidate) => candidate.id === contactId)
    startTransition(async () => {
      try {
        const updatedSteps = unwrapAction(
          await updateSubmittalReviewStepAction({
            step_id: stepId,
            reviewer_contact_id: contactId,
            reviewer_company_id: contact?.primary_company_id ?? null,
          }),
        )
        onStepsChange(updatedSteps)
        setAssigningStepId(null)
        toast.success("Reviewer assigned")
      } catch (error) {
        toast.error("Failed to assign reviewer", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  if (steps.length === 0) return null

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-medium">Review Workflow</h4>
      <div className="space-y-1.5">
        {steps.map((step) => {
          const isCurrent = step.status === "in_review"
          const reviewerLine = [step.reviewer_name, step.reviewer_company_name].filter(Boolean).join(" · ")
          return (
            <div
              key={step.id}
              className={`border p-3 space-y-2 ${isCurrent ? "border-warning/50 bg-warning/5" : ""}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  {step.status === "returned" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
                  ) : isCurrent ? (
                    <Clock className="h-4 w-4 shrink-0 text-warning" />
                  ) : (
                    <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="font-medium">
                    {step.step_order}. {step.role_label || (step.reviewer_kind === "internal" ? "Internal review" : "External review")}
                  </span>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {step.reviewer_kind}
                  </Badge>
                </div>
                <Badge variant="secondary" className={`text-[10px] capitalize border ${stepStatusStyles[step.status] ?? ""}`}>
                  {step.status === "returned" && step.decision ? decisionLabels[step.decision] : step.status.replace(/_/g, " ")}
                </Badge>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {reviewerLine ? <span>{reviewerLine}</span> : <span>No reviewer assigned</span>}
                {step.due_date ? <span>Due {formatLocalDate(step.due_date, "MMM d, yyyy")}</span> : null}
                {step.decided_at ? <span>Returned {formatLocalDate(step.decided_at.slice(0, 10), "MMM d, yyyy")}</span> : null}
              </div>

              {step.notes ? (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">{step.notes}</p>
              ) : null}

              {step.reviewer_kind === "external" &&
              (step.status === "pending" || step.status === "in_review") &&
              !step.reviewer_contact_id ? (
                assigningStepId === step.id ? (
                  <Select onValueChange={(value) => handleAssign(step.id, value)} disabled={isPending}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder={contacts === null ? "Loading contacts..." : "Select reviewer contact"} />
                    </SelectTrigger>
                    <SelectContent>
                      {(contacts ?? []).map((contact) => (
                        <SelectItem key={contact.id} value={contact.id}>
                          <span className="block">{contact.full_name}</span>
                          <span className="block text-[10px] text-muted-foreground">
                            {contact.primary_company?.name ?? contact.email ?? ""}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setAssigningStepId(step.id)}>
                    Assign reviewer
                  </Button>
                )
              ) : null}

              {isCurrent ? (
                <div className="space-y-2 border-t pt-2">
                  <Select value={decision} onValueChange={setDecision}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="approved">Approved</SelectItem>
                      <SelectItem value="approved_as_noted">Approved as Noted</SelectItem>
                      <SelectItem value="revise_resubmit">Revise & Resubmit</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                  <Textarea
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                    placeholder="Step notes, exceptions, or markup summary"
                    rows={2}
                  />
                  <Button size="sm" onClick={handleDecide} disabled={isPending} className="w-full">
                    {isPending ? "Saving..." : "Record step decision"}
                  </Button>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
