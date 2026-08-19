require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  DEFAULT_PREQUAL_TEMPLATE,
  isPrequalFieldEnabled,
  normalizePrequalificationTemplate,
  prequalFieldMode,
  prequalificationReviewSchema,
  prequalificationSubmissionIssues,
  prequalificationSubmissionSchema,
  prequalificationTemplatesMatch,
  prequalificationTemplateSchema,
} = require("../lib/validation/prequalification")

const emptySubmission = (overrides = {}) => ({
  years_in_business: null,
  annual_revenue_cents: null,
  largest_project_cents: null,
  emr: null,
  bonding_single_cents: null,
  bonding_aggregate_cents: null,
  trades: [],
  references_data: [],
  questionnaire: {},
  ...overrides,
})

test("an unconfigured org gets the built-in program", () => {
  const template = normalizePrequalificationTemplate({})
  assert.deepEqual(template.fields, DEFAULT_PREQUAL_TEMPLATE.fields)
  assert.equal(template.questions.length, 0)
  assert.equal(template.references_required, 0)
})

test("a partial stored program is filled in rather than replaced", () => {
  const template = normalizePrequalificationTemplate({ fields: { emr: "required" } })
  assert.equal(prequalFieldMode(template, "emr"), "required")
  // Untouched keys keep the built-in default instead of falling off.
  assert.equal(prequalFieldMode(template, "trades"), "required")
  assert.equal(prequalFieldMode(template, "annual_revenue_cents"), "optional")
})

test("a malformed stored program never throws the page down", () => {
  const template = normalizePrequalificationTemplate({ questions: "not an array" })
  assert.deepEqual(template.fields, DEFAULT_PREQUAL_TEMPLATE.fields)
  assert.equal(template.questions.length, 0)
})

test("a field switched off is not enabled", () => {
  const template = normalizePrequalificationTemplate({ fields: { trades: "off" } })
  assert.equal(isPrequalFieldEnabled(template, "trades"), false)
})

test("a choice question needs at least two options", () => {
  const result = prequalificationTemplateSchema.safeParse({
    questions: [{ id: "bonded", label: "Bonded?", type: "select", options: ["Yes"] }],
  })
  assert.equal(result.success, false)
})

test("duplicate question keys are rejected", () => {
  const result = prequalificationTemplateSchema.safeParse({
    questions: [
      { id: "safety", label: "Safety program?", type: "boolean" },
      { id: "safety", label: "Safety manual?", type: "boolean" },
    ],
  })
  assert.equal(result.success, false)
})

test("the same document type cannot be asked for twice", () => {
  const id = "11111111-1111-4111-8111-111111111111"
  const result = prequalificationTemplateSchema.safeParse({
    documents: [{ document_type_id: id }, { document_type_id: id }],
  })
  assert.equal(result.success, false)
})

test("required standard fields are reported when blank", () => {
  const template = normalizePrequalificationTemplate({
    fields: { emr: "required", trades: "required" },
  })
  const issues = prequalificationSubmissionIssues(template, emptySubmission())
  assert.equal(issues.length, 2)
  assert.ok(issues.some((issue) => issue.includes("EMR")))
  assert.ok(issues.some((issue) => issue.includes("Trades")))
})

test("an optional field left blank is not an issue", () => {
  const template = normalizePrequalificationTemplate({
    fields: { emr: "optional", trades: "off" },
  })
  assert.deepEqual(prequalificationSubmissionIssues(template, emptySubmission()), [])
})

test("zero is a real answer, not a blank one", () => {
  const template = normalizePrequalificationTemplate({
    fields: { years_in_business: "required", trades: "off" },
  })
  const issues = prequalificationSubmissionIssues(
    template,
    emptySubmission({ years_in_business: 0 }),
  )
  assert.deepEqual(issues, [])
})

test("a required question with no answer is reported", () => {
  const template = normalizePrequalificationTemplate({
    fields: { trades: "off" },
    questions: [
      { id: "safety_program", label: "Written safety program?", type: "boolean", required: true },
    ],
  })
  const issues = prequalificationSubmissionIssues(template, emptySubmission())
  assert.equal(issues.length, 1)
  assert.ok(issues[0].includes("Written safety program?"))
})

test("false answers a required yes/no question", () => {
  const template = normalizePrequalificationTemplate({
    fields: { trades: "off" },
    questions: [
      { id: "litigation", label: "Any open litigation?", type: "boolean", required: true },
    ],
  })
  const issues = prequalificationSubmissionIssues(
    template,
    emptySubmission({ questionnaire: { litigation: false } }),
  )
  assert.deepEqual(issues, [])
})

test("too few references is reported against the program", () => {
  const template = normalizePrequalificationTemplate({
    fields: { trades: "off" },
    references_required: 3,
  })
  const issues = prequalificationSubmissionIssues(
    template,
    emptySubmission({
      references_data: [{ company_name: "Acme" }, { company_name: "Globex" }],
    }),
  )
  assert.equal(issues.length, 1)
  assert.ok(issues[0].includes("3 references"))
})

test("a submission parses structured references and answers", () => {
  const parsed = prequalificationSubmissionSchema.parse({
    trades: ["09 Finishes"],
    references_data: [{ company_name: "Acme", amount_cents: 125000 }],
    questionnaire: { safety_program: true, crew_size: 12 },
  })
  assert.equal(parsed.references_data[0].company_name, "Acme")
  assert.equal(parsed.references_data[0].amount_cents, 125000)
  assert.equal(parsed.questionnaire.safety_program, true)
})

test("approving with limits requires a limit", () => {
  assert.equal(
    prequalificationReviewSchema.safeParse({ decision: "approved_with_limits" }).success,
    false,
  )
  assert.equal(
    prequalificationReviewSchema.safeParse({
      decision: "approved_with_limits",
      aggregate_limit_cents: 500000,
    }).success,
    true,
  )
})

test("a plain approval needs no limits", () => {
  assert.equal(prequalificationReviewSchema.safeParse({ decision: "approved" }).success, true)
})

// ── How a program becomes the vendor's route through the form ────────────────

// Turning one field off still leaves the rest of the built-in program on, so a
// test about step *shape* has to silence every standard field explicitly.
const ALL_FIELDS_OFF = {
  years_in_business: "off",
  annual_revenue_cents: "off",
  largest_project_cents: "off",
  emr: "off",
  bonding_single_cents: "off",
  bonding_aggregate_cents: "off",
  trades: "off",
}

const {
  buildPrequalSteps,
  companyFieldsFor,
  issuesForStep,
  stepState,
} = require("../app/s/[token]/prequalification/prequal-steps")

const {
  prequalificationSubmissionIssueList,
} = require("../lib/validation/prequalification")

test("a program with nothing enabled is just the review step", () => {
  const template = normalizePrequalificationTemplate({ fields: ALL_FIELDS_OFF })
  const steps = buildPrequalSteps({ template, documentCount: 0 })
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["review"],
  )
})

test("each question section becomes its own step, in the builder's order", () => {
  const template = normalizePrequalificationTemplate({
    fields: ALL_FIELDS_OFF,
    questions: [
      { id: "emr_letter", label: "EMR letter on file?", type: "boolean", section: "Safety" },
      { id: "bank", label: "Bank reference", type: "text", section: "Financial" },
      { id: "osha", label: "OSHA 300 logs?", type: "boolean", section: "Safety" },
    ],
  })
  const steps = buildPrequalSteps({ template, documentCount: 0 })
  assert.deepEqual(
    steps.map((step) => step.label),
    ["Safety", "Financial", "Review"],
  )
})

test("references and documents steps appear only when asked for", () => {
  const template = normalizePrequalificationTemplate({ fields: ALL_FIELDS_OFF })
  assert.deepEqual(
    buildPrequalSteps({ template, documentCount: 0 }).map((step) => step.kind),
    ["review"],
  )
  assert.deepEqual(
    buildPrequalSteps({ template, documentCount: 2 }).map((step) => step.kind),
    ["documents", "review"],
  )
  const withRefs = normalizePrequalificationTemplate({
    fields: ALL_FIELDS_OFF,
    references_required: 2,
  })
  assert.deepEqual(
    buildPrequalSteps({ template: withRefs, documentCount: 0 }).map((step) => step.kind),
    ["references", "review"],
  )
})

test("only enabled fields reach the company step", () => {
  const template = normalizePrequalificationTemplate({
    fields: { emr: "required", trades: "optional", annual_revenue_cents: "off" },
  })
  const keys = companyFieldsFor(template)
  assert.ok(keys.includes("emr"))
  assert.ok(keys.includes("trades"))
  assert.ok(!keys.includes("annual_revenue_cents"))
})

test("a step reports only its own gaps", () => {
  const template = normalizePrequalificationTemplate({
    fields: { emr: "required", trades: "off" },
    questions: [
      { id: "osha", label: "OSHA 300 logs?", type: "boolean", section: "Safety", required: true },
    ],
    references_required: 1,
  })
  const issues = prequalificationSubmissionIssueList(template, emptySubmission())
  const steps = buildPrequalSteps({ template, documentCount: 0 })

  const company = steps.find((step) => step.kind === "company")
  const safety = steps.find((step) => step.kind === "questions")
  const references = steps.find((step) => step.kind === "references")

  assert.equal(issuesForStep(company, template, issues).length, 1)
  assert.equal(issuesForStep(safety, template, issues).length, 1)
  assert.equal(issuesForStep(references, template, issues).length, 1)
})

test("an unvisited step is not yet failing", () => {
  const template = normalizePrequalificationTemplate({ fields: { emr: "required", trades: "off" } })
  const issues = prequalificationSubmissionIssueList(template, emptySubmission())
  const [company] = buildPrequalSteps({ template, documentCount: 0 })

  assert.equal(stepState({ step: company, template, issues, visited: false }), "untouched")
  assert.equal(stepState({ step: company, template, issues, visited: true }), "incomplete")
})

test("a documents step completes on what the builder already holds", () => {
  const template = normalizePrequalificationTemplate({ fields: ALL_FIELDS_OFF })
  const steps = buildPrequalSteps({ template, documentCount: 1 })
  const documents = steps.find((step) => step.kind === "documents")

  assert.equal(
    stepState({ step: documents, template, issues: [], visited: true, documentsSettled: true }),
    "complete",
  )
  // Never "incomplete" — paperwork must not block sending the questionnaire.
  assert.equal(
    stepState({ step: documents, template, issues: [], visited: true, documentsSettled: false }),
    "untouched",
  )
})

// ── Deciding whether an open request is running an older program ─────────────

test("two equivalent programs match regardless of key order", () => {
  const a = normalizePrequalificationTemplate({
    fields: { emr: "required", trades: "optional" },
    questions: [{ id: "osha", label: "OSHA logs?", type: "boolean", section: "Safety" }],
  })
  const b = normalizePrequalificationTemplate({
    questions: [{ id: "osha", label: "OSHA logs?", type: "boolean", section: "Safety" }],
    fields: { trades: "optional", emr: "required" },
  })
  assert.equal(prequalificationTemplatesMatch(a, b), true)
})

test("document order is not a change, but the document set is", () => {
  const first = "11111111-1111-4111-8111-111111111111"
  const second = "22222222-2222-4222-8222-222222222222"
  const a = normalizePrequalificationTemplate({
    documents: [{ document_type_id: first }, { document_type_id: second }],
  })
  const b = normalizePrequalificationTemplate({
    documents: [{ document_type_id: second }, { document_type_id: first }],
  })
  const c = normalizePrequalificationTemplate({ documents: [{ document_type_id: first }] })

  assert.equal(prequalificationTemplatesMatch(a, b), true)
  assert.equal(prequalificationTemplatesMatch(a, c), false)
})

test("adding a question makes a snapshot stale", () => {
  const before = normalizePrequalificationTemplate({ fields: ALL_FIELDS_OFF })
  const after = normalizePrequalificationTemplate({
    fields: ALL_FIELDS_OFF,
    questions: [{ id: "safety", label: "Safety program?", type: "boolean" }],
  })
  assert.equal(prequalificationTemplatesMatch(before, after), false)
})

test("an empty snapshot differs from a configured program", () => {
  const empty = normalizePrequalificationTemplate({})
  const configured = normalizePrequalificationTemplate({
    questions: [{ id: "safety", label: "Safety program?", type: "boolean" }],
  })
  assert.equal(prequalificationTemplatesMatch(empty, configured), false)
})

test("tightening a field from optional to required is a change", () => {
  const before = normalizePrequalificationTemplate({ fields: { emr: "optional" } })
  const after = normalizePrequalificationTemplate({ fields: { emr: "required" } })
  assert.equal(prequalificationTemplatesMatch(before, after), false)
})

// ── Waiving ──────────────────────────────────────────────────────────────────

const {
  prequalificationWaiverSchema,
} = require("../lib/validation/prequalification")

const {
  isPrequalificationReviewable,
  prequalificationStatusMeta,
} = require("../components/companies/account/prequalification-status")

test("a waiver needs a reason", () => {
  assert.equal(prequalificationWaiverSchema.safeParse({ reason: "" }).success, false)
  assert.equal(prequalificationWaiverSchema.safeParse({ reason: "   " }).success, false)
  assert.equal(
    prequalificationWaiverSchema.safeParse({ reason: "Sole supplier for this material" }).success,
    true,
  )
})

test("a waiver expiry is optional but must be a real date", () => {
  const indefinite = prequalificationWaiverSchema.parse({ reason: "Long-standing vendor" })
  assert.equal(indefinite.expires_at, null)

  const seasonal = prequalificationWaiverSchema.parse({
    reason: "Seasonal",
    expires_at: "2027-01-31",
  })
  assert.equal(seasonal.expires_at, "2027-01-31")

  assert.equal(
    prequalificationWaiverSchema.safeParse({ reason: "Bad date", expires_at: "31/01/2027" })
      .success,
    false,
  )
})

test("a waived package reads as waived, not as never requested", () => {
  assert.equal(prequalificationStatusMeta("waived").label, "Waived")
  assert.equal(prequalificationStatusMeta(null).label, "Not requested")
})

test("a waived package is not waiting on a decision", () => {
  assert.equal(isPrequalificationReviewable("waived"), false)
  assert.equal(isPrequalificationReviewable("requested"), true)
  assert.equal(isPrequalificationReviewable("under_review"), true)
  assert.equal(isPrequalificationReviewable("approved"), false)
})
