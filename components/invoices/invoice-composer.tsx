"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { ArrowLeft, Check, CircleAlert, Loader2, X } from "lucide-react"

import type { Contact, CostCode, Invoice, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import type { ProjectPosture } from "@/lib/product-tier"
import type { ReceivablesPosturePolicy } from "@/lib/receivables/policy"
import {
  createInvoiceAction,
  getInvoiceDetailAction,
  updateInvoiceAction,
} from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import { projectBillingHref, invoiceHref } from "@/lib/financials/invoice-destinations"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

import { ArcInvoiceDocument, toArcInvoiceData, toArcInvoiceLines } from "./arc-invoice-document"
import { InvoiceDocumentEditor, type AutosaveState } from "./invoice-document-editor"
import { balanceCentsOf, formatDateOnly, formatMoneyFromCents, totalCentsOf } from "./invoice-presentation"

/**
 * Composing an invoice is a task, not a transient overlay.
 *
 * It coordinates billing sources, recipients, tax, accounting coding, approvals,
 * autosave, PDF generation and delivery. That was previously a Sheet — a control
 * whose whole promise is "this is small and you can dismiss it" — which is why an
 * accidental click outside could drop you out of a half-composed invoice, and why
 * the document was squeezed into a panel narrower than the document it renders.
 * It now owns a route, so it can be linked to, refreshed, and left with Back.
 *
 * Three steps, and they are the three real decisions: what am I billing, what
 * does it say, and is it right to send.
 */

type ComposerStep = "choose" | "compose" | "review"

export interface BillingSourceOption {
  key: string
  label: string
  description: string
  /** Navigate somewhere else — the artifact that owns this kind of billing. */
  href?: string
  /** Or start the composer directly with this source applied. */
  start?: boolean
}

interface InvoiceComposerProps {
  project: Project
  projects: Project[]
  posture: ProjectPosture
  policy: ReceivablesPosturePolicy
  sources: BillingSourceOption[]
  contacts?: Contact[]
  costCodes?: CostCode[]
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  enableApprovedCostsSource?: boolean
  /** Resume an existing draft instead of starting a new one. */
  initialInvoice?: Invoice | null
  duplicateFrom?: Invoice | null
  initialSourceChangeOrderId?: string
  initialCustomerId?: string
  /** Reserved number for a brand-new draft; released if the session ends unused. */
  reservation?: { number: string; reservationId: string | null } | null
}

export function InvoiceComposer({
  project,
  projects,
  policy,
  sources,
  contacts,
  costCodes,
  builderInfo,
  enableApprovedCostsSource,
  initialInvoice = null,
  duplicateFrom = null,
  initialSourceChangeOrderId,
  initialCustomerId,
  reservation,
}: InvoiceComposerProps) {
  const router = useRouter()
  const billingHref = projectBillingHref(project.id)

  // A resumed draft, a duplicate or a pre-chosen source all skip the picker:
  // the question "what am I billing?" is already answered.
  const [step, setStep] = useState<ComposerStep>(
    initialInvoice || duplicateFrom || initialSourceChangeOrderId || sources.length === 0 ? "compose" : "choose",
  )
  const [autosave, setAutosave] = useState<AutosaveState>("idle")
  const [draftId, setDraftId] = useState<string | null>(initialInvoice?.id ?? null)
  const [leaving, setLeaving] = useState(false)

  const reservationIdRef = useRef(reservation?.reservationId ?? null)
  const draftIdRef = useRef<string | null>(initialInvoice?.id ?? null)
  useEffect(() => {
    draftIdRef.current = draftId
  }, [draftId])

  // Review reads the persisted draft. If it were ever reached without one, go
  // back rather than stranding the person on a spinner.
  useEffect(() => {
    if (step === "review" && !draftId) setStep("compose")
  }, [step, draftId])

  // Release the reserved invoice number only when the session ends WITHOUT
  // producing a draft. The old cleanup raced an unmount autosave that was still
  // claiming the same reservation, so a number could be handed back and consumed
  // at the same time.
  useEffect(() => {
    return () => {
      const reservationId = reservationIdRef.current
      if (!reservationId || draftIdRef.current) return
      const body = JSON.stringify({ reservation_id: reservationId })
      const beaconSent = navigator.sendBeacon?.(
        "/api/invoices/release-reservation",
        new Blob([body], { type: "application/json" }),
      )
      if (beaconSent) return
      void fetch("/api/invoices/release-reservation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => null)
    }
  }, [])

  const handleCreateDraft = useCallback(async (input: InvoiceInput): Promise<Invoice> => {
    const created = unwrapAction(await createInvoiceAction(input))
    setDraftId(created.id)
    draftIdRef.current = created.id
    reservationIdRef.current = null
    return created
  }, [])

  const handleAutosave = useCallback(async (invoiceId: string, input: InvoiceInput): Promise<Invoice> => {
    return unwrapAction(await updateInvoiceAction(invoiceId, input))
  }, [])

  const leave = useCallback(() => {
    setLeaving(true)
    router.push(draftIdRef.current ? invoiceHref(draftIdRef.current, project.id) : billingHref)
  }, [billingHref, project.id, router])

  const steps: Array<{ key: ComposerStep; label: string }> = [
    { key: "choose", label: "What you're billing" },
    { key: "compose", label: "Compose" },
    { key: "review", label: "Review & issue" },
  ]
  const visibleSteps = sources.length === 0 ? steps.slice(1) : steps
  const stepIndex = visibleSteps.findIndex((entry) => entry.key === step)

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex shrink-0 flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon" className="-ml-2 h-8 w-8 shrink-0" onClick={leave} title="Back to billing">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">
              {initialInvoice ? `Invoice ${initialInvoice.invoice_number}` : "New invoice"}
            </h1>
            <p className="truncate text-xs text-muted-foreground">{project.name}</p>
          </div>
        </div>

        <ol className="flex items-center gap-1 text-xs" aria-label="Composer steps">
          {visibleSteps.map((entry, index) => {
            const done = index < stepIndex
            const active = entry.key === step
            return (
              <li key={entry.key} className="flex items-center gap-1">
                {index > 0 ? <span className="px-1 text-muted-foreground/40">›</span> : null}
                <span
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1 font-medium",
                    active ? "text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/60",
                  )}
                  aria-current={active ? "step" : undefined}
                >
                  {done ? <Check className="h-3 w-3 text-success" /> : null}
                  {entry.label}
                </span>
              </li>
            )
          })}
        </ol>

        <div className="flex shrink-0 items-center gap-2">
          <span aria-live="polite" className="text-[11px] text-muted-foreground">
            {autosave === "saving" ? "Saving…" : autosave === "saved" ? "Saved just now" : autosave === "error" ? "Save failed" : ""}
          </span>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={leave} title="Close the composer">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {leaving ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : step === "choose" ? (
        <ChooseWhatToBill
          policy={policy}
          sources={sources}
          onStartCustom={() => setStep("compose")}
        />
      ) : step === "compose" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <InvoiceDocumentEditor
            initialInvoice={initialInvoice}
            projectId={project.id}
            projects={projects}
            builderInfo={builderInfo}
            contacts={contacts}
            costCodes={costCodes}
            initialCustomerId={initialCustomerId}
            enableApprovedCostsSource={enableApprovedCostsSource}
            duplicateFrom={duplicateFrom}
            initialSourceChangeOrderId={initialSourceChangeOrderId}
            reservation={reservation}
            autosaveState={autosave}
            onCreateDraft={handleCreateDraft}
            onAutosave={handleAutosave}
            onAutosaveStateChange={setAutosave}
            onDone={leave}
            onReview={() => setStep("review")}
          />
        </div>
      ) : step === "review" && draftId ? (
        <ReviewStep
          invoiceId={draftId}
          projectName={project.name}
          builderInfo={builderInfo}
          policy={policy}
          onBack={() => setStep("compose")}
          onIssued={(invoice) => {
            setLeaving(true)
            router.replace(invoiceHref(invoice.id, project.id))
          }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  )
}

function ChooseWhatToBill({
  policy,
  sources,
  onStartCustom,
}: {
  policy: ReceivablesPosturePolicy
  sources: BillingSourceOption[]
  onStartCustom: () => void
}) {
  return (
    <div className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-6 py-10">
      <h2 className="text-lg font-semibold">What are you billing?</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {policy.primaryBillingStory === "progress_application"
          ? "Most owner billing on this job flows through a pay application, which builds its own invoice."
          : policy.primaryBillingStory === "deposit_or_closing"
            ? "Buyer money on this job is usually a deposit or a closing statement."
            : "Most billing on this job comes off the draw schedule or approved costs."}
      </p>

      <div className="mt-6 divide-y border">
        {sources.map((source) =>
          source.href ? (
            <Link
              key={source.key}
              href={source.href}
              className="flex items-start justify-between gap-4 px-4 py-3.5 transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{source.label}</span>
                <span className="block text-xs text-muted-foreground">{source.description}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">Open →</span>
            </Link>
          ) : (
            <button
              key={source.key}
              type="button"
              onClick={onStartCustom}
              className="flex w-full items-start justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium">{source.label}</span>
                <span className="block text-xs text-muted-foreground">{source.description}</span>
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">Start →</span>
            </button>
          ),
        )}
      </div>

      <button
        type="button"
        onClick={onStartCustom}
        className="mt-4 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Skip — I'll write the lines myself
      </button>
    </div>
  )
}

/**
 * Review reads the SAVED draft, not the form state. What gets issued is what is
 * in the database, so that is what a person should be asked to approve.
 */
function ReviewStep({
  invoiceId,
  projectName,
  builderInfo,
  policy,
  onBack,
  onIssued,
}: {
  invoiceId: string
  projectName: string
  builderInfo?: { name?: string | null; email?: string | null; address?: string | null }
  policy: ReceivablesPosturePolicy
  onBack: () => void
  onIssued: (invoice: Invoice) => void
}) {
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [loading, setLoading] = useState(true)
  const [recipients, setRecipients] = useState("")
  const [issuing, setIssuing] = useState(false)
  const measureRef = useRef<HTMLDivElement>(null)
  const [docWidth, setDocWidth] = useState(560)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    getInvoiceDetailAction(invoiceId)
      .then((result) => {
        if (cancelled) return
        const detail = unwrapAction(result)
        setInvoice(detail.invoice)
        setRecipients((detail.invoice.sent_to_emails ?? []).join(", ") || String((detail.invoice.metadata as any)?.customer_email ?? ""))
      })
      .catch((error) =>
        toast.error("Could not load the draft", {
          description: error instanceof Error ? error.message : "Please try again.",
        }),
      )
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [invoiceId])

  useEffect(() => {
    const element = measureRef.current
    if (!element) return
    const update = () => setDocWidth(Math.max(320, Math.min(760, element.clientWidth - 32)))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [invoice])

  const parsedRecipients = useMemo(
    () =>
      recipients
        .split(/[,;]+/)
        .map((value) => value.trim())
        .filter(Boolean),
    [recipients],
  )

  const problems = useMemo(() => {
    if (!invoice) return []
    const issues: string[] = []
    if (parsedRecipients.length === 0) issues.push(`Add the ${policy.customerLabel.toLowerCase()}'s email address.`)
    if (parsedRecipients.some((value) => !value.includes("@"))) issues.push("One of the recipients isn't an email address.")
    if (totalCentsOf(invoice) <= 0) issues.push("The invoice totals nothing — check the line items.")
    if (!invoice.due_date) issues.push("There's no due date, so nothing will ever age.")
    if (policy.approvalMode === "required_review" && invoice.approval_status !== "approved") {
      issues.push(`${policy.customerLabel} billing has to be approved before it can be issued.`)
    }
    return issues
  }, [invoice, parsedRecipients, policy])

  async function issue() {
    if (!invoice || problems.length > 0) return
    setIssuing(true)
    try {
      const { issueInvoiceAction } = await import("@/app/(app)/invoices/actions")
      const issued = unwrapAction(await issueInvoiceAction(invoice.id, parsedRecipients))
      toast.success("Invoice issued", { description: `Sent to ${parsedRecipients.join(", ")}` })
      onIssued(issued)
    } catch (error) {
      toast.error("Could not issue the invoice", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    } finally {
      setIssuing(false)
    }
  }

  if (loading || !invoice) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-3xl space-y-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20">
      <div className="mx-auto grid w-full max-w-6xl gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:p-6">
        <div ref={measureRef} className="min-w-0">
          <div className="mx-auto w-fit border bg-background shadow-sm">
            <ArcInvoiceDocument
              data={toArcInvoiceData(invoice, {
                name: builderInfo?.name ?? null,
                email: builderInfo?.email ?? null,
                address: builderInfo?.address ?? null,
                projectName,
                payUrl: null,
              })}
              lines={toArcInvoiceLines(invoice)}
              width={docWidth}
              height={docWidth * 1.294}
            />
          </div>
        </div>

        <aside className="space-y-4">
          <section className="space-y-2 border bg-card p-4">
            <h2 className="microlabel">Before it goes out</h2>
            {problems.length === 0 ? (
              <p className="flex items-start gap-2 text-sm text-success">
                <Check className="mt-0.5 h-4 w-4 shrink-0" />
                Everything checks out.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {problems.map((problem) => (
                  <li key={problem} className="flex items-start gap-2 text-sm text-warning">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-foreground">{problem}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3 border bg-card p-4">
            <h2 className="microlabel">Delivery</h2>
            <div className="space-y-1.5">
              <label htmlFor="composer-recipients" className="text-xs font-medium text-muted-foreground">
                Send to
              </label>
              <Input
                id="composer-recipients"
                value={recipients}
                onChange={(event) => setRecipients(event.target.value)}
                placeholder="client@email.com, lender@bank.com"
                className="h-9"
              />
              <p className="text-[11px] text-muted-foreground">
                Each recipient gets the same secure link. The invoice locks once issued — void and reissue to change it.
              </p>
            </div>
          </section>

          <section className="space-y-1 border bg-card p-4 text-sm">
            <h2 className="microlabel mb-2">Terms</h2>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Issue date</span>
              <span>{formatDateOnly(invoice.issue_date, { withYear: true })}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span className="text-muted-foreground">Due</span>
              <span>{formatDateOnly(invoice.due_date, { withYear: true })}</span>
            </div>
            <div className="mt-2 flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <span>Amount due</span>
              <span className="font-mono tabular-nums">{formatMoneyFromCents(balanceCentsOf(invoice))}</span>
            </div>
          </section>

          <div className="flex items-center gap-2">
            <Button variant="outline" className="flex-1" onClick={onBack} disabled={issuing}>
              Keep editing
            </Button>
            <Button className="flex-1" onClick={() => void issue()} disabled={issuing || problems.length > 0}>
              {issuing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {policy.sendActionLabel}
            </Button>
          </div>
        </aside>
      </div>
    </div>
  )
}
