export type ReviewWorkflowStepState = {
  id: string
  step_order: number
  review_group: number
  status: "pending" | "in_review" | "returned" | "skipped"
  role_label?: string | null
  decision?: "approved" | "approved_as_noted" | "revise_resubmit" | "rejected" | null
}

export function nextPendingReviewGroup(
  steps: ReviewWorkflowStepState[],
  afterGroup = Number.NEGATIVE_INFINITY,
): ReviewWorkflowStepState[] {
  const pending = steps.filter((step) => step.status === "pending" && step.review_group > afterGroup)
  if (pending.length === 0) return []
  const group = Math.min(...pending.map((step) => step.review_group))
  return pending.filter((step) => step.review_group === group).sort((a, b) => a.step_order - b.step_order)
}

export function reviewGroupIsComplete(steps: ReviewWorkflowStepState[], reviewGroup: number): boolean {
  const group = steps.filter((step) => step.review_group === reviewGroup)
  return group.length > 0 && group.every((step) => step.status === "returned" || step.status === "skipped")
}

export function reviewGroupCourtLabel(steps: ReviewWorkflowStepState[]): string {
  const labels = steps.map((step) => step.role_label?.trim()).filter((label): label is string => Boolean(label))
  return labels.length > 0 ? labels.join(" + ") : "In review"
}

export function finalApprovedDecision(
  steps: ReviewWorkflowStepState[],
): "approved" | "approved_as_noted" {
  return steps.some((step) => step.decision === "approved_as_noted") ? "approved_as_noted" : "approved"
}
