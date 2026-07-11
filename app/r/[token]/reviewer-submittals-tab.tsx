"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { FileCheck2, Paperclip } from "lucide-react"
import { toast } from "sonner"

import { formatLocalDate } from "@/lib/utils"
import type { SubmittalItem } from "@/lib/types"
import type { ReviewerQueueEntry } from "@/lib/services/submittals"
import {
  decideReviewerStepAction,
  listReviewerSubmittalItemsAction,
  loadReviewerQueueAction,
} from "./actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"

function isOverdue(value: string | null | undefined) {
  return Boolean(value && new Date(`${value}T23:59:59`).getTime() < Date.now())
}

const decisionLabels: Record<string, string> = {
  approved: "Approve",
  approved_as_noted: "Approve as Noted",
  revise_resubmit: "Revise & Resubmit",
  rejected: "Reject",
}

interface ReviewerSubmittalsTabProps {
  initialQueue: ReviewerQueueEntry[]
  token: string
  onQueueChange?: (count: number) => void
}

export function ReviewerSubmittalsTab({ initialQueue, token, onQueueChange }: ReviewerSubmittalsTabProps) {
  const [queue, setQueue] = useState<ReviewerQueueEntry[]>(initialQueue)
  const [itemsBySubmittal, setItemsBySubmittal] = useState<Record<string, SubmittalItem[]>>({})
  const [decisionByStep, setDecisionByStep] = useState<Record<string, string>>({})
  const [notesByStep, setNotesByStep] = useState<Record<string, string>>({})
  const [decidingStepId, setDecidingStepId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const activeQueue = queue.filter((entry) => !entry.is_history)
  const history = queue.filter((entry) => entry.is_history)

  useEffect(() => {
    for (const entry of queue) {
      const submittalId = entry.submittal.id
      if (itemsBySubmittal[submittalId]) continue
      listReviewerSubmittalItemsAction(token, submittalId)
        .then((items) => setItemsBySubmittal((prev) => ({ ...prev, [submittalId]: items })))
        .catch((error) => console.error("Failed to load submittal items", error))
    }
  }, [queue, itemsBySubmittal, token])

  const handleDecide = (entry: ReviewerQueueEntry) => {
    const stepId = entry.step.id
    const decision = decisionByStep[stepId] ?? "approved"
    setDecidingStepId(stepId)
    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.set("step_id", stepId)
        formData.set("decision", decision)
        formData.set("notes", notesByStep[stepId] ?? "")
        const file = fileInputs.current[stepId]?.files?.[0]
        if (file) formData.set("markup_file", file)

        await decideReviewerStepAction(token, formData)
        toast.success("Review returned", {
          description: `Submittal #${entry.submittal.submittal_number} — ${decisionLabels[decision] ?? decision}`,
        })
        const refreshed = await loadReviewerQueueAction(token)
        setQueue(refreshed)
        onQueueChange?.(refreshed.filter((item) => !item.is_history).length)
      } catch (error) {
        toast.error("Failed to return review", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      } finally {
        setDecidingStepId(null)
      }
    })
  }

  if (queue.length === 0) {
    return (
      <div className="py-12 text-center">
        <FileCheck2 className="mx-auto mb-3 h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">No submittals waiting on your review</p>
        <p className="text-sm text-muted-foreground">
          When a submittal is routed to you, it will appear here with its documents.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {activeQueue.length === 0 ? <div className="border p-6 text-center text-sm text-muted-foreground">No submittals are waiting on your review.</div> : null}
      {activeQueue.map((entry) => {
        const { step, submittal } = entry
        const items = itemsBySubmittal[submittal.id]
        const stepId = step.id
        const numberLabel =
          submittal.revision > 0
            ? `#${submittal.submittal_number} Rev ${submittal.revision}`
            : `#${submittal.submittal_number}`
        return (
          <Card key={stepId}>
            <CardHeader className="pb-2">
              <CardTitle className="flex flex-wrap items-center justify-between gap-2 text-base">
                <span>
                  Submittal {numberLabel}: {submittal.title}
                </span>
                <Badge variant="outline" className="text-xs">
                  {step.role_label ?? "Your review"}
                </Badge>
              </CardTitle>
              <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                {submittal.spec_section ? <span>Spec {submittal.spec_section}</span> : null}
                {step.due_date ? <span className={isOverdue(step.due_date) ? "font-medium text-destructive" : undefined}>{isOverdue(step.due_date) ? "Overdue · " : "Due "}{formatLocalDate(step.due_date, "MMM d, yyyy")}</span> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {submittal.description ? (
                <p className="text-sm text-muted-foreground">{submittal.description}</p>
              ) : null}

              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Documents</p>
                {!items ? (
                  <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
                    <Spinner className="h-4 w-4" /> Loading documents...
                  </div>
                ) : items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No documents submitted yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {items.map((item) => (
                      <li key={item.id} className="flex items-baseline justify-between gap-3 border px-3 py-2 text-sm">
                        <span className="min-w-0 truncate">
                          #{item.item_number} {item.description}
                          {item.manufacturer || item.model_number ? (
                            <span className="text-xs text-muted-foreground">
                              {" "}
                              — {[item.manufacturer, item.model_number].filter(Boolean).join(" · ")}
                            </span>
                          ) : null}
                        </span>
                        {item.file_id ? (
                          <a
                            className="shrink-0 text-xs font-medium text-primary underline underline-offset-2"
                            href={`/api/portal/files/${token}/${item.file_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {item.file_name ?? "Open file"}
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your decision</p>
                <Select
                  value={decisionByStep[stepId] ?? "approved"}
                  onValueChange={(value) => setDecisionByStep((prev) => ({ ...prev, [stepId]: value }))}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(decisionLabels).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Textarea
                  placeholder="Review notes, exceptions, or resubmission instructions"
                  value={notesByStep[stepId] ?? ""}
                  onChange={(event) => setNotesByStep((prev) => ({ ...prev, [stepId]: event.target.value }))}
                  rows={3}
                />
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <Paperclip className="h-3.5 w-3.5" />
                  <span>Attach marked-up file (optional)</span>
                  <input
                    ref={(el) => {
                      fileInputs.current[stepId] = el
                    }}
                    type="file"
                    className="text-xs"
                  />
                </label>
                <Button
                  className="w-full"
                  onClick={() => handleDecide(entry)}
                  disabled={isPending && decidingStepId === stepId}
                >
                  {isPending && decidingStepId === stepId ? "Returning..." : "Return review"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
      {history.length > 0 ? (
        <section className="space-y-2 border-t pt-4">
          <div><h3 className="text-sm font-semibold">Review history</h3><p className="text-xs text-muted-foreground">Your returned decisions on this project.</p></div>
          {history.map(({ step, submittal }) => (
            <div className="flex flex-wrap items-center justify-between gap-3 border px-3 py-2 text-sm" key={step.id}>
              <div className="min-w-0"><p className="truncate font-medium">Submittal #{submittal.submittal_number}: {submittal.title}</p><p className="text-xs text-muted-foreground">{step.role_label ?? "Review"}{step.decided_at ? ` · ${formatLocalDate(step.decided_at.slice(0, 10), "MMM d, yyyy")}` : ""}</p></div>
              <Badge variant="outline">{step.decision ? decisionLabels[step.decision] ?? step.decision : "Returned"}</Badge>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  )
}
