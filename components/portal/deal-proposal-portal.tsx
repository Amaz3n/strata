"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CheckCircle2, Clock, MessageSquare } from "@/components/icons"
import { QuotePortalShell, type PortalStatusTone } from "@/components/portal/quote-portal-shell"
import { QuoteDocumentView, type QuoteViewLine } from "@/components/portal/quote-document-view"
import { EstimatePhotoGallery } from "@/components/portal/estimate-photo-gallery"
import { TakeoffEvidenceDialog } from "@/components/portal/takeoff-evidence-dialog"
import { QuestionAnswer } from "@/components/portal/estimate-portal-client"
import {
  addClientEstimateCommentAction,
  submitEstimateDecisionAction,
  type EstimatePortalPayload,
} from "@/app/e/[token]/actions"
import { unwrapAction } from "@/lib/action-result"
import { normalizeEstimateCommercial } from "@/lib/financials/estimate-commercial"
import {
  firstNames,
  paymentAmounts,
  proposalDocumentLabel,
  type ProposalDocument,
  type ProposalSectionKey,
} from "@/lib/precon/proposal-documents"
import { cn } from "@/lib/utils"

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
const money = (cents: number) => currency.format(cents / 100)
const shortDate = (value: string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" })

/** Every section takes a question except the two the card beside the document answers. */
const NOT_ASKABLE: readonly ProposalSectionKey[] = ["signatures", "questions"]

interface Props {
  token: string
  estimate: EstimatePortalPayload
  proposal: ProposalDocument
  pdfUrl: string
  expired: boolean
}

/**
 * A deal's proposal as the client reads it: what changed since the last
 * version, the document with its options live, a question on any section, and
 * one card that says the total and does the one thing left to do.
 */
export function DealProposalPortal({ token, estimate, proposal, pdfUrl, expired }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const agreement = proposal.kind === "agreement"
  const documentLabel = proposalDocumentLabel(normalizeEstimateCommercial({ precon: estimate.precon }))
  const viewer = estimate.viewer ?? proposal.signers[0] ?? { name: estimate.recipient_name ?? "", email: estimate.recipient_email ?? "" }
  const viewerSignedAt = viewer.email ? estimate.signatures.signed[viewer.email.toLowerCase()] : undefined
  const waitingOn = proposal.signers.filter((signer) => !estimate.signatures.signed[signer.email.toLowerCase()])
  const someoneSigned = Object.keys(estimate.signatures.signed).length > 0
  const executed = ["executed", "converted_to_project"].includes(estimate.status)
  const settled = ["approved", "client_signed", "executed", "converted_to_project", "rejected"].includes(estimate.status)
  const canAct = estimate.is_current_version && !expired && !settled && !viewerSignedAt
  // Every signer signs the same choices, so options lock once anyone has signed.
  const canPick = canAct && !someoneSigned

  const lines = useMemo<QuoteViewLine[]>(
    () =>
      estimate.items.map((item) => ({
        id: item.id,
        kind: item.item_type === "group" ? "section" : "item",
        description: item.description,
        quantity: item.quantity,
        unit: item.unit,
        unit_cost_cents: item.unit_cost_cents,
        amount_cents: item.amount_cents,
        notes: item.notes,
        is_optional: item.is_optional,
        option_group: item.option_group ?? null,
        badges: item.is_allowance ? ["Allowance"] : undefined,
        takeoff_condition_id: item.takeoff_condition_id ?? null,
      })),
    [estimate.items],
  )
  const [takeoffConditionId, setTakeoffConditionId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>(estimate.accepted_options?.ids ?? [])
  const toggle = (id: string) =>
    setSelected((previous) => {
      if (previous.includes(id)) return previous.filter((item) => item !== id)
      const group = estimate.items.find((item) => item.id === id)?.option_group ?? null
      const siblings = group ? new Set(estimate.items.filter((item) => item.option_group === group && item.id !== id).map((item) => item.id)) : null
      return [...(siblings ? previous.filter((item) => !siblings.has(item)) : previous), id]
    })
  const optionSubtotal = selected.reduce((sum, id) => sum + (estimate.items.find((item) => item.id === id)?.amount_cents ?? 0), 0)
  const optionsCents = optionSubtotal + Math.round((optionSubtotal * (estimate.tax_rate ?? 0)) / 100)
  const base = estimate.total_cents ?? 0
  const total = estimate.accepted_options && settled ? estimate.accepted_options.accepted_total_cents : base + optionsCents
  const dueOnSigning = agreement && proposal.payments.length ? (paymentAmounts(base, proposal.payments)[0] ?? 0) + optionsCents : null

  const [signing, setSigning] = useState(false)
  const [changes, setChanges] = useState(false)
  const [asking, setAsking] = useState<ProposalSectionKey | null>(null)
  // A signed price cannot rest on an unanswered question; the server refuses it too.
  const unanswered = agreement ? estimate.questions.filter((question) => !question.answer).length : 0

  function decide(decision: "approved" | "changes_requested", extra: { note?: string; signature?: { name: string; consent: boolean } } = {}) {
    startTransition(async () => {
      try {
        const result = unwrapAction(
          await submitEstimateDecisionAction({
            token,
            decision,
            note: extra.note,
            selected_optional_ids: decision === "approved" ? selected : undefined,
            signature: extra.signature
              ? {
                  signer_name: extra.signature.name,
                  signer_email: viewer.email || null,
                  signature_text: extra.signature.name,
                  consent_accepted: extra.signature.consent,
                }
              : null,
          }),
        )
        toast.success(
          decision === "changes_requested"
            ? `Sent to ${estimate.org_name || "your builder"}.`
            : !agreement
              ? "Approved. Thank you."
              : result.waitingOn.length
                ? `Signed. Waiting on ${firstNames(result.waitingOn)}.`
                : "Signed. Thank you.",
        )
        setSigning(false)
        setChanges(false)
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Something went wrong. Please try again.")
      }
    })
  }

  const status: { label: string; tone: PortalStatusTone } = executed
    ? { label: "Signed by both sides", tone: "success" }
    : estimate.status === "client_signed"
      ? { label: "Signed", tone: "success" }
      : estimate.status === "approved"
        ? { label: "Approved", tone: "success" }
        : estimate.status === "changes_requested"
          ? { label: "Changes requested", tone: "warning" }
          : viewerSignedAt
            ? { label: "You signed", tone: "success" }
            : { label: agreement ? "Ready to sign" : "Ready to review", tone: "info" }

  const comments = estimate.comments.filter((comment) => comment.kind === "comment")
  const answers = new Map(comments.filter((comment) => comment.reply_to).map((comment) => [comment.reply_to, comment]))

  return (
    <QuotePortalShell
      orgName={estimate.org_name}
      orgLogoUrl={estimate.org_logo_url}
      documentLabel={documentLabel}
      statusLabel={status.label}
      statusTone={status.tone}
      pdfUrl={pdfUrl}
      headerExtra={
        estimate.versions.length > 1 ? (
          <select
            aria-label="Version"
            value={estimate.id}
            onChange={(event) => {
              const latest = estimate.versions[0]?.id
              router.push(event.target.value === latest ? `/e/${token}` : `/e/${token}?v=${event.target.value}`)
            }}
            className="h-8 border bg-background px-2 text-xs"
          >
            {estimate.versions.map((version, index) => (
              <option key={version.id} value={version.id}>
                {version.label} v{version.version}
                {index === 0 ? " (latest)" : ` · ${shortDate(version.sent_at)}`}
              </option>
            ))}
          </select>
        ) : null
      }
      banner={
        !estimate.is_current_version ? (
          <div className="flex flex-wrap items-center gap-3 border border-warning/30 bg-warning/10 px-4 py-2.5 text-sm">
            <Clock className="size-4 text-warning" />
            You are reading an earlier version.
            <a href={`/e/${token}`} className="font-semibold underline underline-offset-2">
              Open the latest
            </a>
          </div>
        ) : proposal.changes.length && !settled ? (
          <section className="grid gap-2 border bg-card px-5 py-4 shadow-xs">
            <h2 className="text-sm font-semibold">What changed since the last version</h2>
            <ul className="grid gap-1 pl-4 text-[13px] [list-style:disc]">
              {proposal.changes.map((change) => (
                <li key={change.label}>
                  <span className="font-medium">{change.label}:</span> {change.text}
                </li>
              ))}
            </ul>
          </section>
        ) : null
      }
      document={
        <QuoteDocumentView
          orgName={estimate.org_name}
          orgLogoUrl={estimate.org_logo_url}
          orgAddress={estimate.org_address}
          documentLabel={documentLabel}
          title={estimate.title}
          number={`v${estimate.version}`}
          recipientName={firstNames(proposal.signers.map((signer) => signer.name)) || estimate.recipient_name}
          recipientEmail={estimate.recipient_email}
          projectName={estimate.project_name}
          issuedAt={estimate.issued_at}
          validUntil={estimate.valid_until}
          lines={lines}
          totalCents={base}
          totalRange={estimate.price_range}
          questions={estimate.questions}
          renderAnswer={canAct ? (questionId) => <QuestionAnswer token={token} questionId={questionId} /> : undefined}
          taxCents={(estimate.tax_cents ?? 0) + Math.round((optionSubtotal * (estimate.tax_rate ?? 0)) / 100)}
          contingencyCents={(estimate.total_cents ?? 0) - (estimate.subtotal_cents ?? 0) - (estimate.tax_cents ?? 0)}
          contingencyPercent={estimate.contingency_percent}
          accentColor={estimate.accent_color}
          fontFamily={estimate.font_family}
          pricingDisplay={estimate.pricing_display}
          selectedOptionalIds={selected}
          onToggleOptional={canPick ? toggle : undefined}
          onShowTakeoff={setTakeoffConditionId}
          proposal={proposal}
          signatures={estimate.signatures}
          renderSectionFooter={(id) =>
            !NOT_ASKABLE.includes(id) && estimate.is_current_version ? (
              <SectionThread
                token={token}
                section={id}
                comments={comments.filter((comment) => comment.section === id && comment.author_type === "client")}
                answers={answers}
                open={asking === id}
                onOpen={(open) => setAsking(open ? id : null)}
              />
            ) : null
          }
        />
      }
    >
      <TakeoffEvidenceDialog token={token} conditionId={takeoffConditionId} onClose={() => setTakeoffConditionId(null)} />

      <section className="grid gap-4 border bg-card p-5 shadow-sm">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            {estimate.price_range ? "Estimated range" : agreement ? "Contract price" : "Total"}
          </p>
          <p className="mt-1 text-3xl font-bold tracking-tight tabular-nums" style={{ color: estimate.accent_color ?? undefined }}>
            {estimate.price_range ? `${money(estimate.price_range.lowCents)}–${money(estimate.price_range.highCents)}` : money(total)}
          </p>
          {optionsCents > 0 && <p className="mt-1 text-xs tabular-nums text-muted-foreground">Includes {money(optionsCents)} in options you picked</p>}
        </div>
        {dueOnSigning !== null && (
          <div className="flex justify-between gap-3 border-t pt-3 text-sm tabular-nums">
            <span className="text-muted-foreground">Due on signing</span>
            <span className="font-semibold">{money(dueOnSigning)}</span>
          </div>
        )}
        {agreement && proposal.signers.length > 1 && (
          <ul className="grid gap-1.5 border-t pt-3 text-[13px]">
            {proposal.signers.map((signer) => {
              const at = estimate.signatures.signed[signer.email.toLowerCase()]
              return (
                <li key={signer.email} className="flex items-center justify-between gap-3">
                  <span className="min-w-0 truncate">
                    {signer.name}
                    {signer.email.toLowerCase() === viewer.email.toLowerCase() ? " (you)" : ""}
                  </span>
                  <span className={cn("shrink-0 text-xs", at ? "text-success" : "text-muted-foreground")}>
                    {at ? `Signed ${shortDate(at)}` : "Not yet"}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        {executed ? (
          <Outcome tone="success" title="Signed by both sides" detail={`${estimate.org_name || "Your builder"} countersigned. The PDF is your copy.`} />
        ) : estimate.status === "client_signed" ? (
          <Outcome tone="success" title="Signed" detail={`Waiting on ${estimate.org_name || "your builder"} to countersign.`} />
        ) : estimate.status === "approved" ? (
          <Outcome tone="success" title="Estimate approved" detail="Your builder firms up the price and sends a proposal to sign." />
        ) : viewerSignedAt ? (
          <Outcome tone="success" title={`You signed ${shortDate(viewerSignedAt)}`} detail={waitingOn.length ? `Waiting on ${firstNames(waitingOn.map((signer) => signer.name))}.` : ""} />
        ) : estimate.status === "changes_requested" ? (
          <Outcome tone="warning" title="Changes requested" detail={`${estimate.org_name || "Your builder"} is revising it and will send a new version here.`} />
        ) : expired ? (
          <Outcome tone="warning" title="This has expired" detail="Ask your builder for an updated copy." />
        ) : null}

        {canAct && (
          <div className="grid gap-2 border-t pt-4">
            {!agreement && (
              <p className="text-xs text-muted-foreground">
                Approving says the scope and range work for you. It is not a contract and does not start work.
              </p>
            )}
            {unanswered > 0 && (
              <p className="text-xs text-warning">
                Answer {unanswered === 1 ? "the question" : `the ${unanswered} questions`} in the proposal first. Your builder prices from your answers.
              </p>
            )}
            <Button className="h-11 text-sm" disabled={pending || unanswered > 0} onClick={() => (agreement ? setSigning(true) : decide("approved"))}>
              <CheckCircle2 className="size-4" />
              {agreement ? "Sign" : "Approve the estimate"}
            </Button>
            <Button variant="outline" className="h-9" disabled={pending} onClick={() => setChanges(true)}>
              Ask for changes
            </Button>
          </div>
        )}
      </section>

      {estimate.photos.length > 0 && (
        <section className="border bg-card p-5">
          <EstimatePhotoGallery photos={estimate.photos} accentColor={estimate.accent_color} />
        </section>
      )}

      <SignDialog
        open={signing}
        onOpenChange={setSigning}
        name={viewer.name}
        total={money(total)}
        pending={pending}
        onSign={(name, consent) => decide("approved", { signature: { name, consent } })}
      />
      <ChangesDialog open={changes} onOpenChange={setChanges} pending={pending} onSend={(note) => decide("changes_requested", { note })} />
    </QuotePortalShell>
  )
}

function Outcome({ tone, title, detail }: { tone: "success" | "warning"; title: string; detail: string }) {
  return (
    <div className={cn("flex items-start gap-2.5 border p-3 text-sm", tone === "success" ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5")}>
      {tone === "success" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <Clock className="mt-0.5 size-4 shrink-0 text-warning" />}
      <div>
        <p className={cn("font-semibold", tone === "success" ? "text-success" : "text-warning")}>{title}</p>
        {detail && <p className="text-muted-foreground">{detail}</p>}
      </div>
    </div>
  )
}

/** A question on one section, asked where it applies; the builder's answer appears under it. */
function SectionThread({
  token,
  section,
  comments,
  answers,
  open,
  onOpen,
}: {
  token: string
  section: ProposalSectionKey
  comments: EstimatePortalPayload["comments"]
  answers: Map<string | null, EstimatePortalPayload["comments"][number]>
  open: boolean
  onOpen: (open: boolean) => void
}) {
  const router = useRouter()
  const [body, setBody] = useState("")
  const [pending, startTransition] = useTransition()
  return (
    <div className="mt-3 grid gap-2 print:hidden">
      {comments.map((comment) => {
        const answer = answers.get(comment.id)
        return (
          <div key={comment.id} className="grid gap-1.5 border bg-muted/40 px-3 py-2 text-[12.5px]">
            <p className="text-[11px] text-muted-foreground">
              {comment.author_name || "You"} · {shortDate(comment.created_at)}
            </p>
            <p className="whitespace-pre-wrap">{comment.body}</p>
            {answer ? (
              <div className="border-t pt-1.5">
                <p className="text-[11px] text-muted-foreground">
                  {answer.author_name || "Your builder"} · {shortDate(answer.created_at)}
                </p>
                <p className="whitespace-pre-wrap">{answer.body}</p>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">Waiting on an answer</p>
            )}
          </div>
        )
      })}
      {open ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            startTransition(async () => {
              try {
                unwrapAction(await addClientEstimateCommentAction({ token, body, section }))
                setBody("")
                onOpen(false)
                toast.success("Sent. The answer appears right here.")
                router.refresh()
              } catch (error) {
                toast.error(error instanceof Error ? error.message : "Your question was not sent. Try again.")
              }
            })
          }}
        >
          <Textarea autoFocus value={body} onChange={(event) => setBody(event.target.value)} rows={3} placeholder="Your question" className="text-[13px]" />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || !body.trim()}>
              {pending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => onOpen(true)}
          className="inline-flex items-center gap-1.5 justify-self-start text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          <MessageSquare className="size-3.5" />
          Ask about this
        </button>
      )}
    </div>
  )
}

function SignDialog({
  open,
  onOpenChange,
  name: initialName,
  total,
  pending,
  onSign,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  name: string
  total: string
  pending: boolean
  onSign: (name: string, consent: boolean) => void
}) {
  const [name, setName] = useState(initialName)
  const [consent, setConsent] = useState(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign the agreement</DialogTitle>
          <DialogDescription>Typing your name signs the agreement at {total}, with the options you picked.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="proposal-signer-name">Full name</Label>
            <Input id="proposal-signer-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          </div>
          <div aria-hidden className="flex h-16 items-end border-b border-foreground px-1 pb-1.5 font-serif text-2xl italic">
            {name}
          </div>
          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <Checkbox checked={consent} onCheckedChange={(checked) => setConsent(checked === true)} className="mt-0.5" />
            <span>
              I agree to sign electronically, I can keep a copy of this agreement, and I intend my typed name to be my legally binding signature.{" "}
              <a href="/esign-terms" target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                Electronic signature terms
              </a>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSign(name.trim(), consent)} disabled={pending || !consent || name.trim().length < 2}>
            {pending ? "Signing…" : "Sign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChangesDialog({
  open,
  onOpenChange,
  pending,
  onSend,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onSend: (note: string) => void
}) {
  const [note, setNote] = useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Ask for changes</DialogTitle>
          <DialogDescription>Say what you would like changed. Your builder sends a new version to this same link.</DialogDescription>
        </DialogHeader>
        <Textarea autoFocus value={note} onChange={(event) => setNote(event.target.value)} rows={5} placeholder="e.g. Can we price engineered oak instead of solid?" />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onSend(note.trim())} disabled={pending || note.trim().length < 3}>
            {pending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
