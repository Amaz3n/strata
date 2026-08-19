import { z } from "zod"

const optionalMoney = z.number().int().nonnegative().nullable().optional()

/**
 * The built-in facts every prequalification can ask for. An org turns each one
 * off, on, or on-and-required; anything beyond this list is a custom question.
 */
export const PREQUAL_FIELD_KEYS = [
  "years_in_business",
  "annual_revenue_cents",
  "largest_project_cents",
  "emr",
  "bonding_single_cents",
  "bonding_aggregate_cents",
  "trades",
] as const

export type PrequalFieldKey = (typeof PREQUAL_FIELD_KEYS)[number]

export const PREQUAL_FIELD_LABELS: Record<PrequalFieldKey, string> = {
  years_in_business: "Years in business",
  annual_revenue_cents: "Annual revenue",
  largest_project_cents: "Largest completed project",
  emr: "EMR (experience modification rate)",
  bonding_single_cents: "Single bond capacity",
  bonding_aggregate_cents: "Aggregate bond capacity",
  trades: "Trades / CSI divisions",
}

const fieldModeSchema = z.enum(["off", "optional", "required"])
export type PrequalFieldMode = z.infer<typeof fieldModeSchema>

const prequalFieldsSchema = z
  .object({
    years_in_business: fieldModeSchema,
    annual_revenue_cents: fieldModeSchema,
    largest_project_cents: fieldModeSchema,
    emr: fieldModeSchema,
    bonding_single_cents: fieldModeSchema,
    bonding_aggregate_cents: fieldModeSchema,
    trades: fieldModeSchema,
  })
  .partial()

export const PREQUAL_QUESTION_TYPES = [
  "text",
  "longtext",
  "number",
  "money",
  "boolean",
  "date",
  "select",
] as const

export const prequalQuestionSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_]+$/, "Question key must be lowercase letters, numbers, and underscores"),
    section: z.string().trim().min(1).max(60).default("General"),
    label: z.string().trim().min(1).max(300),
    type: z.enum(PREQUAL_QUESTION_TYPES),
    options: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    required: z.boolean().default(false),
    help: z.string().trim().max(500).default(""),
  })
  .superRefine((value, context) => {
    if (value.type === "select" && value.options.length < 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["options"],
        message: "A choice question needs at least two options",
      })
    }
  })

const prequalDocumentRequirementSchema = z.object({
  document_type_id: z.string().uuid(),
  is_required: z.boolean().default(true),
})

export const prequalificationTemplateSchema = z
  .object({
    fields: prequalFieldsSchema.default({}),
    questions: z.array(prequalQuestionSchema).max(60).default([]),
    documents: z.array(prequalDocumentRequirementSchema).max(30).default([]),
    references_required: z.number().int().min(0).max(10).default(0),
    instructions: z.string().trim().max(2000).default(""),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    value.questions.forEach((question, index) => {
      if (seen.has(question.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["questions", index, "id"],
          message: `Duplicate question key "${question.id}"`,
        })
      }
      seen.add(question.id)
    })

    const seenDocuments = new Set<string>()
    value.documents.forEach((document, index) => {
      if (seenDocuments.has(document.document_type_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["documents", index, "document_type_id"],
          message: "This document type is already on the program",
        })
      }
      seenDocuments.add(document.document_type_id)
    })
  })

export type PrequalificationTemplate = z.infer<typeof prequalificationTemplateSchema>
export type PrequalificationQuestion = z.infer<typeof prequalQuestionSchema>

/**
 * What an org gets before it has configured anything: the fields the fixed form
 * used to collect, none of them mandatory except the trades that decide which
 * bid packages a vendor belongs on.
 */
export const DEFAULT_PREQUAL_TEMPLATE: PrequalificationTemplate = {
  fields: {
    years_in_business: "optional",
    annual_revenue_cents: "optional",
    largest_project_cents: "optional",
    emr: "optional",
    bonding_single_cents: "optional",
    bonding_aggregate_cents: "optional",
    trades: "required",
  },
  questions: [],
  documents: [],
  references_required: 0,
  instructions: "",
}

/**
 * Coerce whatever is stored — an empty object, a partial program, a snapshot
 * written by an older release — into a complete template. Never throws: a
 * malformed stored program must not take down the page that renders it.
 */
export function normalizePrequalificationTemplate(raw?: unknown): PrequalificationTemplate {
  const parsed = prequalificationTemplateSchema.safeParse(raw ?? {})
  const value = parsed.success ? parsed.data : DEFAULT_PREQUAL_TEMPLATE
  return {
    ...value,
    fields: { ...DEFAULT_PREQUAL_TEMPLATE.fields, ...value.fields },
  }
}

export function prequalFieldMode(
  template: PrequalificationTemplate,
  key: PrequalFieldKey,
): PrequalFieldMode {
  return template.fields[key] ?? "off"
}

export function isPrequalFieldEnabled(
  template: PrequalificationTemplate,
  key: PrequalFieldKey,
): boolean {
  return prequalFieldMode(template, key) !== "off"
}

/**
 * A stable serialization of what a program actually asks for, so two templates
 * can be compared without key order or a re-save counting as a change.
 */
function canonicalTemplate(template: PrequalificationTemplate): string {
  return JSON.stringify({
    fields: PREQUAL_FIELD_KEYS.map((key) => [key, prequalFieldMode(template, key)]),
    questions: template.questions.map((question) => [
      question.id,
      question.section,
      question.label,
      question.type,
      question.options,
      question.required,
      question.help,
    ]),
    documents: [...template.documents]
      .sort((a, b) => a.document_type_id.localeCompare(b.document_type_id))
      .map((document) => [document.document_type_id, document.is_required]),
    references_required: template.references_required,
    instructions: template.instructions,
  })
}

/** True when two programs ask for exactly the same things. */
export function prequalificationTemplatesMatch(
  a: PrequalificationTemplate,
  b: PrequalificationTemplate,
): boolean {
  return canonicalTemplate(a) === canonicalTemplate(b)
}

const prequalReferenceSchema = z.object({
  company_name: z.string().trim().min(1, "Reference company is required").max(200),
  contact_name: z.string().trim().max(160).default(""),
  email: z.union([z.string().trim().email().max(200), z.literal("")]).default(""),
  phone: z.string().trim().max(50).default(""),
  project_description: z.string().trim().max(500).default(""),
  amount_cents: z.number().int().nonnegative().nullable().default(null),
})

export type PrequalificationReference = z.infer<typeof prequalReferenceSchema>

const prequalAnswerSchema = z.union([
  z.string().max(5000),
  z.number(),
  z.boolean(),
  z.null(),
])

export const prequalificationSubmissionSchema = z.object({
  years_in_business: z.number().int().min(0).max(500).nullable().optional(),
  annual_revenue_cents: optionalMoney,
  largest_project_cents: optionalMoney,
  emr: z.number().min(0).max(10).nullable().optional(),
  bonding_single_cents: optionalMoney,
  bonding_aggregate_cents: optionalMoney,
  trades: z.array(z.string().trim().min(1).max(100)).max(49).default([]),
  references_data: z.array(prequalReferenceSchema).max(20).default([]),
  questionnaire: z.record(prequalAnswerSchema).default({}),
  submitted_by_name: z.string().trim().max(160).optional(),
  submitted_by_email: z.union([z.string().trim().email().max(200), z.literal("")]).optional(),
})

export type PrequalificationSubmission = z.infer<typeof prequalificationSubmissionSchema>

function isBlank(value: unknown): boolean {
  if (value == null) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Enough of a submission to judge completeness — the shape a stored
 * prequalification row and a freshly parsed form payload have in common.
 */
export interface PrequalificationSubmissionSnapshot {
  years_in_business?: number | null
  annual_revenue_cents?: number | null
  largest_project_cents?: number | null
  emr?: number | null
  bonding_single_cents?: number | null
  bonding_aggregate_cents?: number | null
  trades?: string[] | null
  references_data?: ReadonlyArray<unknown> | null
  questionnaire?: Record<string, unknown> | null
}

/** Which control an issue belongs to, so a form can show it in place. */
export type PrequalificationIssueField =
  | PrequalFieldKey
  | `question:${string}`
  | "references"

export interface PrequalificationIssue {
  field: PrequalificationIssueField
  message: string
}

/**
 * The template decides what "complete" means, so completeness is checked
 * against the snapshot rather than baked into the schema. Both the portal
 * (before submitting) and the service (before accepting) run this, so a
 * hand-rolled POST cannot skip a question the builder made mandatory.
 */
export function prequalificationSubmissionIssueList(
  template: PrequalificationTemplate,
  submission: PrequalificationSubmissionSnapshot,
): PrequalificationIssue[] {
  const issues: PrequalificationIssue[] = []

  for (const key of PREQUAL_FIELD_KEYS) {
    if (prequalFieldMode(template, key) !== "required") continue
    if (isBlank(submission[key])) {
      issues.push({ field: key, message: `${PREQUAL_FIELD_LABELS[key]} is required` })
    }
  }

  for (const question of template.questions) {
    if (!question.required) continue
    if (isBlank(submission.questionnaire?.[question.id])) {
      issues.push({ field: `question:${question.id}`, message: `"${question.label}" is required` })
    }
  }

  if ((submission.references_data?.length ?? 0) < template.references_required) {
    issues.push({
      field: "references",
      message: `${template.references_required} reference${template.references_required === 1 ? "" : "s"} required`,
    })
  }

  return issues
}

/** The same rules, flattened for callers that only report a list of problems. */
export function prequalificationSubmissionIssues(
  template: PrequalificationTemplate,
  submission: PrequalificationSubmissionSnapshot,
): string[] {
  return prequalificationSubmissionIssueList(template, submission).map((issue) => issue.message)
}

export const prequalificationWaiverSchema = z.object({
  reason: z.string().trim().min(1, "Say why this vendor does not need to prequalify").max(2000),
  /** Null waives indefinitely; a date waives for a season. */
  expires_at: z.string().date().nullable().optional().default(null),
})

export type PrequalificationWaiverInput = z.infer<typeof prequalificationWaiverSchema>

export const prequalificationReviewSchema = z
  .object({
    decision: z.enum(["approved", "approved_with_limits", "declined"]),
    expires_at: z.string().date().nullable().optional(),
    single_project_limit_cents: optionalMoney,
    aggregate_limit_cents: optionalMoney,
    review_notes: z.string().trim().max(5000).nullable().optional(),
  })
  .superRefine((value, context) => {
    if (
      value.decision === "approved_with_limits" &&
      value.single_project_limit_cents == null &&
      value.aggregate_limit_cents == null
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "At least one approval limit is required" })
    }
  })
