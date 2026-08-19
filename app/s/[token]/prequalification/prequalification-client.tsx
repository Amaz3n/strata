"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { SuccessCheck } from "@/components/portal/success-check"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ArrowLeft, ArrowRight, Check, Plus, X } from "@/components/icons"
import { cn } from "@/lib/utils"
import type { Prequalification } from "@/lib/services/prequalification"
import {
  PREQUAL_FIELD_LABELS,
  prequalFieldMode,
  prequalificationSubmissionIssueList,
  type PrequalFieldKey,
  type PrequalificationIssue,
  type PrequalificationReference,
  type PrequalificationTemplate,
} from "@/lib/validation/prequalification"
import { DocumentsStep, documentSlotState } from "./prequal-documents"
import {
  ChipInput,
  Field,
  MoneyInput,
  PlainInput,
  QuestionField,
  type AnswerValue,
} from "./prequal-fields"
import {
  buildPrequalSteps,
  companyFieldsFor,
  issuesForStep,
  stepState,
  type PrequalStep,
} from "./prequal-steps"
import type { PortalDocumentSlot } from "./prequal-types"


const MONEY_FIELDS: ReadonlySet<PrequalFieldKey> = new Set([
  "annual_revenue_cents",
  "largest_project_cents",
  "bonding_single_cents",
  "bonding_aggregate_cents",
])

const FIELD_HINTS: Partial<Record<PrequalFieldKey, string>> = {
  emr: "Your experience modification rate from your workers' comp carrier. Usually near 1.00.",
  bonding_single_cents: "The largest single bond your surety will write for you.",
  bonding_aggregate_cents: "The total bonding your surety will carry at one time.",
  largest_project_cents: "The biggest contract your company has completed.",
}

const EMPTY_REFERENCE: PrequalificationReference = {
  company_name: "",
  contact_name: "",
  email: "",
  phone: "",
  project_description: "",
  amount_cents: null,
}

interface DraftShape {
  fields: Record<string, string>
  trades: string[]
  answers: Record<string, AnswerValue>
  references: PrequalificationReference[]
  contactName: string
  contactEmail: string
}

function toCents(value: string): number | null {
  const trimmed = value.replaceAll(",", "").trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(String(value).replaceAll(",", ""))
  return Number.isFinite(parsed) ? parsed : null
}

function money(cents: number | null): string {
  if (cents == null) return "—"
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function TerminalCard({
  tone,
  title,
  children,
}: {
  tone: "success" | "neutral" | "destructive"
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "border p-6 sm:p-8",
        tone === "success"
          ? "border-success/30 bg-success/5"
          : tone === "destructive"
            ? "border-destructive/30 bg-destructive/5"
            : "border-border bg-card",
      )}
    >
      {tone === "success" ? (
        <div className="mb-4">
          <SuccessCheck />
        </div>
      ) : null}
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <div className="mt-2 space-y-2 text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

export function PrequalificationClient({
  token,
  initial,
  documentSlots,
}: {
  token: string
  initial: Prequalification | null
  documentSlots: PortalDocumentSlot[]
}) {
  const router = useRouter()
  const [prequalification, setPrequalification] = useState(initial)
  const [pending, startTransition] = useTransition()
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [justSubmitted, setJustSubmitted] = useState(false)

  const [fields, setFields] = useState<Record<string, string>>({})
  const [trades, setTrades] = useState<string[]>([])
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({})
  const [references, setReferences] = useState<PrequalificationReference[]>([])
  const [contactName, setContactName] = useState("")
  const [contactEmail, setContactEmail] = useState("")

  const [stepIndex, setStepIndex] = useState(0)
  const [visited, setVisited] = useState<string[]>([])
  const [attempted, setAttempted] = useState<string[]>([])
  const [restored, setRestored] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const template = prequalification?.template ?? null
  const draftKey = prequalification ? `arc.prequal.draft.${prequalification.id}` : null

  const steps = useMemo(
    () =>
      template
        ? buildPrequalSteps({ template, documentCount: documentSlots.length })
        : ([] as PrequalStep[]),
    [template, documentSlots.length],
  )

  // Restore after mount, never during render — the server has no localStorage
  // and reading it inline would hydrate a different tree than it sent.
  useEffect(() => {
    if (!draftKey || restored) return
    try {
      const raw = window.localStorage.getItem(draftKey)
      if (raw) {
        const draft = JSON.parse(raw) as Partial<DraftShape>
        if (draft.fields) setFields(draft.fields)
        if (draft.trades) setTrades(draft.trades)
        if (draft.answers) setAnswers(draft.answers)
        if (draft.references) setReferences(draft.references)
        if (draft.contactName) setContactName(draft.contactName)
        if (draft.contactEmail) setContactEmail(draft.contactEmail)
      }
    } catch {
      // A corrupt draft is not worth blocking the form over.
    }
    setRestored(true)
  }, [draftKey, restored])

  // A sub fills this out between jobs, on a phone, and will close the tab.
  useEffect(() => {
    if (!draftKey || !restored) return
    const handle = window.setTimeout(() => {
      try {
        const draft: DraftShape = {
          fields,
          trades,
          answers,
          references,
          contactName,
          contactEmail,
        }
        window.localStorage.setItem(draftKey, JSON.stringify(draft))
        setSavedAt(Date.now())
      } catch {
        // Private browsing and full quotas both land here; the form still works.
      }
    }, 600)
    return () => window.clearTimeout(handle)
  }, [draftKey, restored, fields, trades, answers, references, contactName, contactEmail])

  const submission = useMemo(
    () => ({
      years_in_business: toNumber(fields.years_in_business),
      annual_revenue_cents: toCents(fields.annual_revenue_cents ?? ""),
      largest_project_cents: toCents(fields.largest_project_cents ?? ""),
      emr: toNumber(fields.emr),
      bonding_single_cents: toCents(fields.bonding_single_cents ?? ""),
      bonding_aggregate_cents: toCents(fields.bonding_aggregate_cents ?? ""),
      trades,
      references_data: references.filter((reference) => reference.company_name.trim()),
      questionnaire: answers,
      submitted_by_name: contactName.trim() || undefined,
      submitted_by_email: contactEmail.trim() || undefined,
    }),
    [fields, trades, references, answers, contactName, contactEmail],
  )

  const issues: PrequalificationIssue[] = useMemo(
    () => (template ? prequalificationSubmissionIssueList(template, submission) : []),
    [template, submission],
  )

  const errorFor = useCallback(
    (step: PrequalStep | undefined, field: string): string | undefined => {
      if (!step || !attempted.includes(step.id)) return undefined
      return issues.find((issue) => issue.field === field)?.message
    },
    [attempted, issues],
  )

  const step = steps[stepIndex]

  useEffect(() => {
    if (step && !visited.includes(step.id)) setVisited((prev) => [...prev, step.id])
  }, [step, visited])

  if (!prequalification || !template) {
    return (
      <TerminalCard tone="neutral" title="Nothing to complete yet">
        <p>
          This builder has not asked {""}
          for a prequalification. If you were expecting one, reply to whoever sent you this link.
        </p>
      </TerminalCard>
    )
  }

  if (justSubmitted) {
    return (
      <TerminalCard tone="success" title="Sent to the builder">
        <p>
          Your prequalification is with the builder&apos;s team. They will email you when it has
          been reviewed.
        </p>
        {documentSlots.some((slot) => !documentSlotState(slot).settled) ? (
          <p>
            Some documents are still outstanding. You can add them any time from the Compliance
            section — you do not need a new link.
          </p>
        ) : null}
      </TerminalCard>
    )
  }

  if (!["requested", "submitted"].includes(prequalification.status)) {
    const approved =
      prequalification.status === "approved" || prequalification.status === "approved_with_limits"
    const declined = prequalification.status === "declined"
    return (
      <TerminalCard
        tone={approved ? "success" : declined || prequalification.status === "expired" ? "destructive" : "neutral"}
        title={
          approved
            ? "You are prequalified"
            : declined
              ? "Not approved"
              : prequalification.status === "expired"
                ? "Prequalification expired"
                : "With the builder for review"
        }
      >
        {prequalification.submitted_at ? (
          <p>Submitted {new Date(prequalification.submitted_at).toLocaleDateString()}.</p>
        ) : null}
        {approved && prequalification.expires_at ? (
          <p>
            Valid until{" "}
            <span className="font-medium text-foreground">
              {new Date(prequalification.expires_at).toLocaleDateString()}
            </span>
            .
          </p>
        ) : null}
        {approved && prequalification.single_project_limit_cents != null ? (
          <p>
            Approved up to{" "}
            <span className="font-medium tabular-nums text-foreground">
              {money(prequalification.single_project_limit_cents)}
            </span>{" "}
            per project.
          </p>
        ) : null}
        {prequalification.review_notes ? (
          <p className="whitespace-pre-wrap border-l-2 border-border pl-3 text-foreground">
            {prequalification.review_notes}
          </p>
        ) : null}
        {prequalification.status === "expired" ? (
          <p>Ask your contact to send a new request when you are ready to requalify.</p>
        ) : null}
      </TerminalCard>
    )
  }

  const companyFields = companyFieldsFor(template)
  const documentsSettled = documentSlots.every((slot) => documentSlotState(slot).settled)
  const answerableSteps = steps.filter((candidate) => candidate.kind !== "review")
  const completedSteps = answerableSteps.filter(
    (candidate) =>
      stepState({ step: candidate, template, issues, visited: true, documentsSettled }) ===
      "complete",
  ).length
  const progress =
    answerableSteps.length === 0
      ? 100
      : Math.round((completedSteps / answerableSteps.length) * 100)

  const goTo = (index: number) => {
    setStepIndex(Math.min(Math.max(index, 0), steps.length - 1))
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const advance = () => {
    if (!step) return
    const own = issuesForStep(step, template, issues)
    if (own.length > 0) {
      setAttempted((prev) => (prev.includes(step.id) ? prev : [...prev, step.id]))
      return
    }
    goTo(stepIndex + 1)
  }

  const submit = () => {
    if (issues.length > 0) {
      setAttempted(steps.map((candidate) => candidate.id))
      const firstBroken = steps.findIndex(
        (candidate) => issuesForStep(candidate, template, issues).length > 0,
      )
      if (firstBroken >= 0) goTo(firstBroken)
      return
    }

    startTransition(async () => {
      setSubmitError(null)
      const response = await fetch(`/api/portal/s/${token}/prequalification`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        setSubmitError(body.error ?? "We could not send that. Try again in a moment.")
        return
      }
      if (draftKey) {
        try {
          window.localStorage.removeItem(draftKey)
        } catch {
          // Nothing to do; the draft is stale but harmless.
        }
      }
      setPrequalification(body)
      setJustSubmitted(true)
      router.refresh()
    })
  }

  const askedFor = [
    companyFields.length > 0 ? `${companyFields.length} company details` : null,
    template.questions.length > 0
      ? `${template.questions.length} question${template.questions.length === 1 ? "" : "s"}`
      : null,
    template.references_required > 0 ? `${template.references_required} references` : null,
    documentSlots.length > 0 ? `${documentSlots.length} documents` : null,
  ].filter(Boolean)

  return (
    <div className="space-y-5 pb-4">
      {/* What this is and how far along they are. */}
      <section className="border border-border bg-card">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 p-4 sm:p-5">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Prequalification
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">
              {steps.length > 1 ? `${steps.length} short steps` : "One short step"}
            </h2>
            {askedFor.length > 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">{askedFor.join(" · ")}</p>
            ) : null}
          </div>
          <div className="text-right">
            <div className="font-mono text-2xl tabular-nums leading-none">{progress}%</div>
            <p className="mt-1 text-xs text-muted-foreground">
              {savedAt ? "Progress saved" : "Saves as you go"}
            </p>
          </div>
        </div>
        <Progress value={progress} className="h-1" />
      </section>

      {template.instructions ? (
        <p className="border-l-2 border-primary bg-muted/40 px-4 py-3 text-sm">
          {template.instructions}
        </p>
      ) : null}

      <div className="gap-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Rail: a scrollable row on a phone, a list on a laptop. */}
        <nav aria-label="Prequalification steps" className="mb-4 lg:mb-0">
          <ol className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
            {steps.map((candidate, index) => {
              const state = stepState({
                step: candidate,
                template,
                issues,
                visited: visited.includes(candidate.id),
                documentsSettled,
              })
              const active = index === stepIndex
              return (
                <li key={candidate.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    onClick={() => goTo(index)}
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "flex w-full items-center gap-2 border px-3 py-2 text-left text-sm transition-colors",
                      active
                        ? "border-primary bg-primary/10 font-medium text-foreground"
                        : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular-nums",
                        state === "complete"
                          ? "border-success bg-success text-success-foreground"
                          : state === "incomplete"
                            ? "border-destructive text-destructive"
                            : active
                              ? "border-primary text-primary"
                              : "border-border",
                      )}
                    >
                      {state === "complete" ? <Check className="size-3" /> : index + 1}
                    </span>
                    <span className="truncate">{candidate.label}</span>
                  </button>
                </li>
              )
            })}
          </ol>
        </nav>

        <section key={step?.id} className="prequal-step-in min-w-0">
          <div className="border border-border bg-card">
            <header className="border-b border-border px-4 py-4 sm:px-6">
              <h3 className="text-base font-semibold tracking-tight">{step?.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{step?.hint}</p>
            </header>

            <div className="space-y-6 px-4 py-5 sm:px-6 sm:py-6">
              {step?.kind === "company" ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  {companyFields.map((key) => {
                    const required = prequalFieldMode(template, key) === "required"
                    const error = errorFor(step, key)
                    const inputId = `field-${key}`

                    if (key === "trades") {
                      return (
                        <Field
                          key={key}
                          label={PREQUAL_FIELD_LABELS[key]}
                          htmlFor={inputId}
                          required={required}
                          error={error}
                          hint="Type a trade and press Enter. Add as many as you self-perform."
                          className="sm:col-span-2"
                        >
                          <ChipInput
                            id={inputId}
                            values={trades}
                            onChange={setTrades}
                            invalid={Boolean(error)}
                            placeholder="Drywall, Painting…"
                          />
                        </Field>
                      )
                    }

                    return (
                      <Field
                        key={key}
                        label={PREQUAL_FIELD_LABELS[key]}
                        htmlFor={inputId}
                        required={required}
                        error={error}
                        hint={FIELD_HINTS[key]}
                      >
                        {MONEY_FIELDS.has(key) ? (
                          <MoneyInput
                            id={inputId}
                            value={fields[key] ?? ""}
                            onChange={(value) => setFields({ ...fields, [key]: value })}
                            invalid={Boolean(error)}
                            placeholder="0"
                          />
                        ) : (
                          <PlainInput
                            id={inputId}
                            inputMode={key === "years_in_business" ? "numeric" : "decimal"}
                            value={fields[key] ?? ""}
                            onChange={(value) => setFields({ ...fields, [key]: value })}
                            invalid={Boolean(error)}
                            suffix={key === "years_in_business" ? "years" : undefined}
                            placeholder={key === "emr" ? "1.00" : undefined}
                          />
                        )}
                      </Field>
                    )
                  })}
                </div>
              ) : null}

              {step?.kind === "questions"
                ? template.questions
                    .filter((question) => question.section === step.section)
                    .map((question) => (
                      <QuestionField
                        key={question.id}
                        question={question}
                        value={answers[question.id] ?? null}
                        onChange={(value) => setAnswers({ ...answers, [question.id]: value })}
                        error={errorFor(step, `question:${question.id}`)}
                      />
                    ))
                : null}

              {step?.kind === "references" ? (
                <ReferencesStep
                  references={references}
                  required={template.references_required}
                  error={errorFor(step, "references")}
                  onChange={setReferences}
                />
              ) : null}

              {step?.kind === "documents" ? (
                <DocumentsStep
                  token={token}
                  prequalificationId={prequalification.id}
                  slots={documentSlots}
                />
              ) : null}

              {step?.kind === "review" ? (
                <ReviewStep
                  template={template}
                  steps={steps}
                  submission={submission}
                  documentSlots={documentSlots}
                  issues={issues}
                  contactName={contactName}
                  contactEmail={contactEmail}
                  onContactName={setContactName}
                  onContactEmail={setContactEmail}
                  onEdit={(id) => goTo(steps.findIndex((candidate) => candidate.id === id))}
                />
              ) : null}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                disabled={stepIndex === 0}
                onClick={() => goTo(stepIndex - 1)}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>

              {step?.kind === "review" ? (
                <Button type="button" className="h-11 px-6" disabled={pending} onClick={submit}>
                  {pending ? "Sending…" : "Send to builder"}
                </Button>
              ) : (
                <Button type="button" className="h-11" onClick={advance}>
                  Continue
                  <ArrowRight className="size-4" />
                </Button>
              )}
            </footer>
          </div>

          {submitError ? (
            <p className="mt-3 border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm font-medium text-destructive">
              {submitError}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function ReferencesStep({
  references,
  required,
  error,
  onChange,
}: {
  references: PrequalificationReference[]
  required: number
  error?: string
  onChange: (references: PrequalificationReference[]) => void
}) {
  const update = (index: number, patch: Partial<PrequalificationReference>) =>
    onChange(references.map((item, i) => (i === index ? { ...item, ...patch } : item)))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {references.length} of {required} added
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-10"
          onClick={() => onChange([...references, { ...EMPTY_REFERENCE }])}
        >
          <Plus className="size-4" />
          Add reference
        </Button>
      </div>

      {error ? <p className="text-xs font-medium text-destructive">{error}</p> : null}

      {references.length === 0 ? (
        <div className="border border-dashed border-border px-4 py-10 text-center">
          <p className="text-sm font-medium">No references yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Add {required} recent {required === 1 ? "project" : "projects"} with a contact the
            builder can actually reach.
          </p>
        </div>
      ) : (
        references.map((reference, index) => (
          <div key={index} className="border border-border p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Reference {index + 1}
              </span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8"
                aria-label={`Remove reference ${index + 1}`}
                onClick={() => onChange(references.filter((_, i) => i !== index))}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Company"
                htmlFor={`ref-company-${index}`}
                required
                className="sm:col-span-2"
              >
                <PlainInput
                  id={`ref-company-${index}`}
                  value={reference.company_name}
                  onChange={(value) => update(index, { company_name: value })}
                  placeholder="Who you did the work for"
                />
              </Field>
              <Field label="Contact name" htmlFor={`ref-contact-${index}`}>
                <PlainInput
                  id={`ref-contact-${index}`}
                  value={reference.contact_name}
                  onChange={(value) => update(index, { contact_name: value })}
                />
              </Field>
              <Field label="Phone" htmlFor={`ref-phone-${index}`}>
                <PlainInput
                  id={`ref-phone-${index}`}
                  inputMode="tel"
                  value={reference.phone}
                  onChange={(value) => update(index, { phone: value })}
                />
              </Field>
              <Field label="Email" htmlFor={`ref-email-${index}`}>
                <PlainInput
                  id={`ref-email-${index}`}
                  type="email"
                  inputMode="email"
                  value={reference.email}
                  onChange={(value) => update(index, { email: value })}
                />
              </Field>
              <Field label="Contract amount" htmlFor={`ref-amount-${index}`}>
                <MoneyInput
                  id={`ref-amount-${index}`}
                  value={
                    reference.amount_cents == null
                      ? ""
                      : (reference.amount_cents / 100).toLocaleString("en-US")
                  }
                  onChange={(value) => update(index, { amount_cents: toCents(value) })}
                  placeholder="0"
                />
              </Field>
              <Field label="What you did" htmlFor={`ref-scope-${index}`} className="sm:col-span-2">
                <PlainInput
                  id={`ref-scope-${index}`}
                  value={reference.project_description}
                  onChange={(value) => update(index, { project_description: value })}
                  placeholder="Scope of your work on the job"
                />
              </Field>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm">{value}</span>
    </div>
  )
}

function ReviewStep({
  template,
  steps,
  submission,
  documentSlots,
  issues,
  contactName,
  contactEmail,
  onContactName,
  onContactEmail,
  onEdit,
}: {
  template: PrequalificationTemplate
  steps: PrequalStep[]
  submission: {
    years_in_business: number | null
    annual_revenue_cents: number | null
    largest_project_cents: number | null
    emr: number | null
    bonding_single_cents: number | null
    bonding_aggregate_cents: number | null
    trades: string[]
    references_data: PrequalificationReference[]
    questionnaire: Record<string, AnswerValue>
  }
  documentSlots: PortalDocumentSlot[]
  issues: PrequalificationIssue[]
  contactName: string
  contactEmail: string
  onContactName: (value: string) => void
  onContactEmail: (value: string) => void
  onEdit: (stepId: string) => void
}) {
  const companyFields = companyFieldsFor(template)

  const valueFor = (key: PrequalFieldKey): string => {
    if (key === "trades") return submission.trades.length ? submission.trades.join(", ") : "—"
    if (key === "emr") return submission.emr != null ? submission.emr.toFixed(2) : "—"
    if (key === "years_in_business") {
      return submission.years_in_business != null ? `${submission.years_in_business} years` : "—"
    }
    return money(submission[key])
  }

  const answerText = (value: AnswerValue): string => {
    if (value === null || value === undefined || value === "") return "—"
    if (typeof value === "boolean") return value ? "Yes" : "No"
    return String(value)
  }

  const outstandingDocuments = documentSlots.filter((slot) => !documentSlotState(slot).settled)

  return (
    <div className="space-y-6">
      {issues.length > 0 ? (
        <div className="border border-destructive/40 bg-destructive/5 px-4 py-3">
          <p className="text-sm font-medium text-destructive">
            {issues.length} thing{issues.length === 1 ? "" : "s"} still needed
          </p>
          <ul className="mt-1.5 space-y-0.5 text-sm text-destructive">
            {issues.map((issue) => (
              <li key={`${issue.field}-${issue.message}`}>{issue.message}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
          Everything the builder asked for is filled in.
        </p>
      )}

      {companyFields.length > 0 ? (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Company</h4>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => onEdit("company")}
            >
              Edit
            </Button>
          </div>
          {companyFields.map((key) => (
            <SummaryRow key={key} label={PREQUAL_FIELD_LABELS[key]} value={valueFor(key)} />
          ))}
        </section>
      ) : null}

      {steps
        .filter((candidate) => candidate.kind === "questions")
        .map((candidate) => (
          <section key={candidate.id}>
            <div className="mb-1 flex items-center justify-between">
              <h4 className="text-sm font-semibold">{candidate.label}</h4>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8"
                onClick={() => onEdit(candidate.id)}
              >
                Edit
              </Button>
            </div>
            {template.questions
              .filter((question) => question.section === candidate.section)
              .map((question) => (
                <SummaryRow
                  key={question.id}
                  label={question.label}
                  value={answerText(submission.questionnaire[question.id] ?? null)}
                />
              ))}
          </section>
        ))}

      {template.references_required > 0 ? (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h4 className="text-sm font-semibold">References</h4>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => onEdit("references")}
            >
              Edit
            </Button>
          </div>
          {submission.references_data.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">None added</p>
          ) : (
            submission.references_data.map((reference, index) => (
              <SummaryRow
                key={index}
                label={reference.company_name}
                value={
                  [reference.contact_name, reference.phone || reference.email]
                    .filter(Boolean)
                    .join(" · ") || "No contact"
                }
              />
            ))
          )}
        </section>
      ) : null}

      {documentSlots.length > 0 ? (
        <section>
          <div className="mb-1 flex items-center justify-between">
            <h4 className="text-sm font-semibold">Documents</h4>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={() => onEdit("documents")}
            >
              Edit
            </Button>
          </div>
          {documentSlots.map((slot) => (
            <SummaryRow
              key={slot.document_type_id}
              label={slot.name}
              value={documentSlotState(slot).label}
            />
          ))}
          {outstandingDocuments.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              You can send this now and add the rest later — documents are never blocked by the
              questionnaire.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="border-t border-border pt-5">
        <h4 className="text-sm font-semibold">Who filled this out</h4>
        <p className="mt-1 text-sm text-muted-foreground">
          So the builder knows who to come back to with questions.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Your name" htmlFor="submitted-by-name">
            <PlainInput id="submitted-by-name" value={contactName} onChange={onContactName} />
          </Field>
          <Field label="Your email" htmlFor="submitted-by-email">
            <PlainInput
              id="submitted-by-email"
              type="email"
              inputMode="email"
              value={contactEmail}
              onChange={onContactEmail}
            />
          </Field>
        </div>
      </section>
    </div>
  )
}
