import {
  PREQUAL_FIELD_KEYS,
  prequalFieldMode,
  type PrequalFieldKey,
  type PrequalificationIssue,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification"

export type PrequalStepKind = "company" | "questions" | "references" | "documents" | "review"

export interface PrequalStep {
  id: string
  kind: PrequalStepKind
  /** Nav label — short enough for a rail on a phone. */
  label: string
  title: string
  hint: string
  /** Only set on a questions step. */
  section?: string
}

/**
 * A program becomes a route through the form. Sections the builder did not ask
 * for never appear, so a vendor asked for three fields sees one short step
 * rather than a form with four empty headings.
 */
export function buildPrequalSteps({
  template,
  documentCount,
}: {
  template: PrequalificationTemplate
  documentCount: number
}): PrequalStep[] {
  const steps: PrequalStep[] = []

  const hasCompanyFields = PREQUAL_FIELD_KEYS.some(
    (key) => prequalFieldMode(template, key) !== "off",
  )
  if (hasCompanyFields) {
    steps.push({
      id: "company",
      kind: "company",
      label: "Company",
      title: "About your company",
      hint: "Basic facts the builder uses to size the work they can award you.",
    })
  }

  // Sections keep the order the builder wrote them in, not alphabetical — the
  // program reads as a document, and reordering it would lose their intent.
  const sections: string[] = []
  for (const question of template.questions) {
    if (!sections.includes(question.section)) sections.push(question.section)
  }
  for (const section of sections) {
    steps.push({
      id: `section:${section}`,
      kind: "questions",
      label: section,
      title: section,
      hint: "Answer what applies to your company.",
      section,
    })
  }

  if (template.references_required > 0) {
    steps.push({
      id: "references",
      kind: "references",
      label: "References",
      title: "Project references",
      hint: "Recent work the builder can call about.",
    })
  }

  if (documentCount > 0) {
    steps.push({
      id: "documents",
      kind: "documents",
      label: "Documents",
      title: "Documents",
      hint: "Upload what is missing. Anything already on file is reused.",
    })
  }

  steps.push({
    id: "review",
    kind: "review",
    label: "Review",
    title: "Review and send",
    hint: "Check it over, then send it to the builder.",
  })

  return steps
}

/** Standard fields shown on the company step, in a fixed, readable order. */
export function companyFieldsFor(template: PrequalificationTemplate): PrequalFieldKey[] {
  return PREQUAL_FIELD_KEYS.filter((key) => prequalFieldMode(template, key) !== "off")
}

/** The issues that belong to one step, so each step reports only its own gaps. */
export function issuesForStep(
  step: PrequalStep,
  template: PrequalificationTemplate,
  issues: PrequalificationIssue[],
): PrequalificationIssue[] {
  switch (step.kind) {
    case "company":
      return issues.filter((issue) => PREQUAL_FIELD_KEYS.includes(issue.field as PrequalFieldKey))
    case "questions": {
      const ids = new Set(
        template.questions
          .filter((question) => question.section === step.section)
          .map((question) => `question:${question.id}`),
      )
      return issues.filter((issue) => ids.has(issue.field))
    }
    case "references":
      return issues.filter((issue) => issue.field === "references")
    default:
      return []
  }
}

export type StepState = "complete" | "incomplete" | "untouched"

/**
 * A step is only marked incomplete once the vendor has been there. Flagging
 * every unvisited step red on arrival reads as a wall of failure before they
 * have typed anything.
 *
 * Documents are judged by what the builder already holds rather than by the
 * form's own state, because a certificate on file from last year satisfies the
 * request without the vendor touching this step at all. They are also never
 * marked incomplete: the questionnaire can be sent while paperwork catches up.
 */
export function stepState({
  step,
  template,
  issues,
  visited,
  documentsSettled,
}: {
  step: PrequalStep
  template: PrequalificationTemplate
  issues: PrequalificationIssue[]
  visited: boolean
  documentsSettled?: boolean
}): StepState {
  if (step.kind === "review") return "untouched"
  if (step.kind === "documents") return documentsSettled ? "complete" : "untouched"
  const own = issuesForStep(step, template, issues)
  if (own.length === 0) return "complete"
  return visited ? "incomplete" : "untouched"
}
