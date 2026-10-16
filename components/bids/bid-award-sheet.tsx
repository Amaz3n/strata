"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { format, parseISO } from "date-fns"
import { toast } from "sonner"

import type { BidAddendum, BidAwardResult, BidPackage, BidScopeItem, BidSubmission, PriceBookAwardPreviewLine } from "@/lib/services/bids"
import { itemForScope } from "@/lib/bids/leveling"
import { awardBidSubmissionAction, previewPriceBookAwardAction } from "@/app/(app)/bids/actions"
import { listAttachmentsAction } from "@/app/(app)/documents/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn, formatMoneyCents } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { AlertTriangle, CheckCircle2 } from "@/components/icons"
import { signedMoney, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

type Coverage = "allowance" | "other_package" | "owner" | "not_needed"

const COVERAGE: Array<{ value: Coverage; label: string; phrase: string }> = [
  { value: "allowance", label: "Carry an allowance", phrase: "carried as an allowance" },
  { value: "other_package", label: "Another package", phrase: "by another package" },
  { value: "owner", label: "Owner provides", phrase: "provided by the owner" },
  { value: "not_needed", label: "Not needed", phrase: "not required" },
]

const day = (value: string) => format(new Date(value), "MMM d, yyyy")
const calendarDay = (value: string) => format(parseISO(value), "MMM d, yyyy")

/**
 * The award, as one decision: what you're buying, who covers what the trade
 * left out, whether they're ready to hire, and the words the subcontract will
 * carry. Awarding drafts the subcontract; the next screen is that document.
 */
export function BidAwardSheet({
  open,
  onOpenChange,
  context,
  bidPackage,
  submission,
  companyName,
  scopeItems,
  addenda,
  budgetCents,
  onAwarded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  context: BidWorkbenchContext
  bidPackage: BidPackage
  submission: BidSubmission
  companyName: string
  scopeItems: BidScopeItem[]
  addenda: BidAddendum[]
  budgetCents: number | null
  onAwarded: (result: BidAwardResult) => void
}) {
  const priceBook = bidPackage.award_target === "price_agreement"
  const [alternates, setAlternates] = useState<Set<string>>(new Set())
  const [coverage, setCoverage] = useState<Record<string, Coverage>>({})
  const [scopeText, setScopeText] = useState<string | null>(null)
  const [termsText, setTermsText] = useState<string | null>(null)
  const [exception, setException] = useState("")
  const [notes, setNotes] = useState("")
  const [bondVerified, setBondVerified] = useState(false)
  const [hasBondEvidence, setHasBondEvidence] = useState<boolean | null>(null)
  const [isAwarding, startAwarding] = useTransition()
  const today = new Date().toISOString().slice(0, 10)
  const [effectiveFrom, setEffectiveFrom] = useState(today)
  const [displacement, setDisplacement] = useState<{ lines: PriceBookAwardPreviewLine[]; error: string | null } | null>(null)

  useEffect(() => {
    if (!open || !bidPackage.bond_required) return
    let active = true
    listAttachmentsAction("bid_submission", submission.id)
      .then((links) => {
        if (active) setHasBondEvidence((links ?? []).length > 0)
      })
      .catch(() => {
        if (active) setHasBondEvidence(null)
      })
    return () => {
      active = false
    }
  }, [open, bidPackage.bond_required, submission.id])

  const effectiveValid = effectiveFrom >= today && effectiveFrom <= new Date(Date.now() + 366 * 86_400_000).toISOString().slice(0, 10)
  const alternateKey = Array.from(alternates).sort().join(",")
  useEffect(() => {
    if (!open || !priceBook || !effectiveValid) return
    let active = true
    setDisplacement(null)
    previewPriceBookAwardAction({
      bid_submission_id: submission.id,
      effective_from: effectiveFrom,
      accepted_alternate_ids: alternateKey ? alternateKey.split(",") : [],
    }).then((result) => {
      if (active) setDisplacement(result.success ? { lines: result.data, error: null } : { lines: [], error: result.error })
    })
    return () => {
      active = false
    }
  }, [open, priceBook, effectiveValid, effectiveFrom, alternateKey, submission.id])

  const pricedAlternates = scopeItems
    .filter((scope) => scope.item_type === "alternate")
    .map((scope) => ({ scope, item: itemForScope(submission, scope.id) }))
    .filter((entry) => entry.item?.response === "priced" && entry.item.amount_cents != null)
  const unpricedAlternates = scopeItems.filter(
    (scope) => scope.item_type === "alternate" && !pricedAlternates.some((entry) => entry.scope.id === scope.id),
  )
  const gaps = scopeItems.filter(
    (scope) => scope.item_type !== "alternate" && itemForScope(submission, scope.id)?.response !== "priced",
  )
  const baseLines = scopeItems.filter((scope) => scope.item_type !== "alternate")

  const alternatesCents = pricedAlternates
    .filter((entry) => alternates.has(entry.scope.id))
    .reduce((sum, entry) => sum + (entry.item?.amount_cents ?? 0), 0)
  const contractCents = (submission.total_cents ?? 0) + alternatesCents
  const allowanceCents = gaps.reduce(
    (sum, scope) => sum + (coverage[scope.id] === "allowance" ? itemForScope(submission, scope.id)?.gc_plug_cents ?? scope.budget_cents ?? 0 : 0),
    0,
  )
  const allCovered = gaps.every((scope) => coverage[scope.id])

  const draftScope = (() => {
    const parts: string[] = []
    if (bidPackage.scope?.trim()) parts.push(bidPackage.scope.trim())
    const included = baseLines.filter((scope) => !gaps.includes(scope))
    if (included.length) {
      parts.push(["Work included:", ...included.map((scope) => `• ${scope.description}${scope.quantity != null ? ` (${scope.quantity} ${scope.unit ?? ""})`.replace(/ \)$/, ")") : ""}`)].join("\n"))
    }
    const accepted = pricedAlternates.filter((entry) => alternates.has(entry.scope.id))
    if (accepted.length) parts.push(["Alternates accepted:", ...accepted.map((entry) => `• ${entry.scope.description}`)].join("\n"))
    if (gaps.length) {
      parts.push(
        [
          "Excluded from this subcontract:",
          ...gaps.map((scope) => {
            const phrase = COVERAGE.find((option) => option.value === coverage[scope.id])?.phrase
            return `• ${scope.description}${phrase ? ` — ${phrase}` : ""}`
          }),
        ].join("\n"),
      )
    }
    if (submission.clarifications?.trim()) parts.push(`Bidder's clarifications: ${submission.clarifications.trim()}`)
    if (submission.exclusions?.trim()) parts.push(`Bidder's exclusions: ${submission.exclusions.trim()}`)
    parts.push(
      `Priced against scope revision ${bidPackage.scope_revision ?? 1}${addenda.length ? ` including addenda 1–${addenda.length}` : ""}.`,
    )
    return parts.join("\n\n")
  })()

  const draftTerms = useMemo(() => {
    const parts = ["Contract sum per the schedule of values, including accepted alternates."]
    if (submission.submitted_at) {
      parts.push(`Per the bid dated ${day(submission.submitted_at)}${submission.valid_until ? `, valid until ${day(submission.valid_until)}` : ""}.`)
    }
    const schedule = [
      submission.start_available_on ? `available to start ${day(submission.start_available_on)}` : null,
      submission.lead_time_days != null ? `lead time ${submission.lead_time_days} days` : null,
      submission.duration_days != null ? `duration ${submission.duration_days} days` : null,
    ].filter(Boolean)
    if (schedule.length) parts.push(`Schedule: ${schedule.join(", ")}.`)
    if (bidPackage.bond_required) parts.push("Performance and payment bond required.")
    return parts.join("\n")
  }, [submission, bidPackage.bond_required])

  const scope = scopeText ?? draftScope
  const terms = termsText ?? draftTerms

  const prequal = submission.invite?.prequalification_warning
  const compliance = submission.invite?.compliance_warning
  const bondOpen = bidPackage.bond_required && !bondVerified
  const needsException = Boolean(prequal || compliance || bondOpen)
  const ready = allCovered && scope.trim() && terms.trim() && (!needsException || exception.trim()) && contractCents >= 0 && (!priceBook || effectiveValid)

  function award() {
    if (!ready) return
    startAwarding(async () => {
      try {
        const result = unwrapAction(
          await awardBidSubmissionAction(
            { ...context, bidPackageId: bidPackage.id },
            {
              bid_submission_id: submission.id,
              accepted_alternate_ids: Array.from(alternates),
              reviewed_scope: scope.trim(),
              reviewed_terms: terms.trim(),
              readiness_exception: exception.trim() || undefined,
              bond_verified: bondVerified,
              notes: notes.trim() || null,
              effective_from: priceBook ? effectiveFrom : undefined,
            },
          ),
        )
        onOpenChange(false)
        onAwarded(result)
      } catch (error) {
        toast.error("Award not recorded", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92dvh] max-w-4xl flex-col gap-0 p-0">
        <DialogHeader className="space-y-1 px-6 pb-4 pt-6 text-left">
          <DialogTitle className="text-xl tracking-tight">
            {priceBook ? `Add ${companyName} to the price book` : `Award ${companyName}`}
          </DialogTitle>
          <DialogDescription>
            {priceBook
              ? "Their prices become the price book for every house that uses them."
              : `Drafts the subcontract${bidPackage.cost_code_code ? ` against ${bidPackage.cost_code_code}` : ""}. You'll review the full agreement next, before anything is sent.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-y-auto border-t md:grid-cols-2">
          <div className="space-y-4 px-6 py-5">
            <p className="microlabel">What you're buying</p>
            <Line
              label={baseLines.length ? `Base bid, ${baseLines.length - gaps.length} of ${baseLines.length} lines` : "Their bid"}
              value={formatMoneyCents(submission.total_cents ?? null)}
            />
            {pricedAlternates.map((entry) => (
              <label key={entry.scope.id} className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                <span className="flex items-center gap-2.5">
                  <Switch
                    checked={alternates.has(entry.scope.id)}
                    onCheckedChange={(on) =>
                      setAlternates((current) => {
                        const next = new Set(current)
                        if (on) next.add(entry.scope.id)
                        else next.delete(entry.scope.id)
                        return next
                      })
                    }
                  />
                  {entry.scope.description}
                </span>
                <span className="font-mono tabular-nums">{signedMoney(entry.item?.amount_cents ?? 0)}</span>
              </label>
            ))}
            {unpricedAlternates.map((scope) => (
              <Line key={scope.id} muted label={scope.description} value="No bid" />
            ))}
            <div className="border-t border-foreground/70 pt-2.5">
              <Line strong label={priceBook ? "Total" : "Subcontract value"} value={formatMoneyCents(contractCents)} />
              {budgetCents ? (
                <div className="mt-1 flex justify-between text-xs text-muted-foreground">
                  <span>vs budget {formatMoneyCents(budgetCents)}{allowanceCents ? ", with allowances" : ""}</span>
                  <span className={cn("font-mono tabular-nums", contractCents + allowanceCents > budgetCents ? "text-destructive" : "text-success")}>
                    {signedMoney(contractCents + allowanceCents - budgetCents)}
                  </span>
                </div>
              ) : null}
            </div>

            {priceBook ? (
              <div className="space-y-3 pt-2">
                <div className="space-y-1.5">
                  <Label htmlFor="award-effective-from">Effective from</Label>
                  <Input id="award-effective-from" type="date" min={today} value={effectiveFrom} onChange={(event) => setEffectiveFrom(event.target.value)} className="w-44" aria-invalid={!effectiveValid} />
                  {!effectiveValid ? <p className="text-xs text-destructive">Choose today or a date up to a year ahead.</p> : null}
                </div>
                <p className="microlabel">Replaces</p>
                {displacement === null ? (
                  <div className="h-10 animate-pulse bg-muted" aria-busy="true" />
                ) : displacement.error ? (
                  <p role="alert" className="text-xs text-destructive">Could not preview what this replaces: {displacement.error}</p>
                ) : displacement.lines.every((line) => line.replaces.length === 0) ? (
                  <p className="text-xs text-muted-foreground">No standing price in this scope. These are new prices.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th className="py-1 font-medium">Line</th>
                        <th className="py-1 font-medium">Vendor</th>
                        <th className="py-1 text-right font-medium">Was</th>
                        <th className="py-1 text-right font-medium">Now</th>
                        <th className="py-1 text-right font-medium">Change</th>
                        <th className="py-1 text-right font-medium">Ends</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displacement.lines.flatMap((line) =>
                        line.replaces.map((replaced) => (
                          <tr key={`${line.costCodeId}:${replaced.agreementId}`} className="border-b last:border-b-0">
                            <td className="py-1.5 pr-2">{line.costCode ? <span className="font-mono">{line.costCode}</span> : null} {line.description}</td>
                            <td className="py-1.5 pr-2">{replaced.vendorName}</td>
                            <td className="py-1.5 text-right font-mono tabular-nums">{formatMoneyCents(replaced.price.cents)}</td>
                            <td className="py-1.5 text-right font-mono tabular-nums">{formatMoneyCents(line.price.cents)}</td>
                            <td className={cn("py-1.5 text-right font-mono tabular-nums", replaced.deltaCents != null && replaced.deltaCents > 0 && "text-destructive", replaced.deltaCents != null && replaced.deltaCents < 0 && "text-success")}>
                              {replaced.deltaPct != null ? `${replaced.deltaPct > 0 ? "+" : ""}${replaced.deltaPct}%` : "—"}
                            </td>
                            <td className="py-1.5 text-right tabular-nums">{calendarDay(replaced.endsOn)}</td>
                          </tr>
                        )),
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}

            {gaps.length ? (
              <div className="space-y-3 pt-2">
                <p className="microlabel">Who covers what they left out</p>
                {gaps.map((scopeItem) => (
                  <div key={scopeItem.id} className="space-y-1.5">
                    <p className="text-sm">{scopeItem.description}</p>
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {COVERAGE.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setCoverage((current) => ({ ...current, [scopeItem.id]: option.value }))}
                          className={cn(
                            "border px-2 py-1.5 text-xs transition-colors hover:border-muted-foreground",
                            coverage[scopeItem.id] === option.value && "border-primary bg-primary/[0.05] text-foreground",
                          )}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="space-y-4 border-t bg-muted/30 px-6 py-5 md:border-l md:border-t-0">
            <p className="microlabel">Ready to commit</p>
            <Gate ok={!prequal} label={prequal ?? "Prequalified"} />
            <Gate ok={!compliance} label={compliance ?? "Insurance and paperwork current"} />
            {submission.valid_until ? <Gate ok label={`Price holds until ${day(submission.valid_until)}`} /> : null}
            <Gate ok label={`Priced against scope revision ${bidPackage.scope_revision ?? 1}`} />
            {gaps.length ? <Gate ok={allCovered} label={allCovered ? "Excluded scope has an owner" : "Say who covers the excluded scope"} /> : null}
            {bidPackage.bond_required ? (
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={bondVerified} disabled={hasBondEvidence !== true} onCheckedChange={(value) => setBondVerified(value === true)} className="mt-0.5" />
                <span>
                  I reviewed their bond and it meets this package&apos;s requirements
                  {hasBondEvidence === false ? <span className="block text-xs text-warning">They haven&apos;t attached a bond.</span> : null}
                </span>
              </label>
            ) : null}
            {needsException ? (
              <div className="space-y-1.5">
                <Label htmlFor="award-exception">Why you're proceeding anyway</Label>
                <Textarea id="award-exception" rows={2} value={exception} onChange={(event) => setException(event.target.value)} placeholder="Who approved it and on what conditions" />
              </div>
            ) : null}

            <div className="space-y-2 pt-2">
              <p className="microlabel">{priceBook ? "Agreed scope" : "The subcontract will say"}</p>
              <Textarea aria-label="Scope of work" rows={7} value={scope} onChange={(event) => setScopeText(event.target.value)} className="bg-card text-[13px] leading-relaxed" />
              <Textarea aria-label="Terms" rows={4} value={terms} onChange={(event) => setTermsText(event.target.value)} className="bg-card text-[13px] leading-relaxed" />
              {scopeText !== null || termsText !== null ? (
                <Button variant="ghost" size="sm" className="h-7 px-0 text-xs text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => { setScopeText(null); setTermsText(null) }}>
                  Rewrite from the bid
                </Button>
              ) : null}
            </div>

            <Textarea aria-label="Award notes" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Notes for the record (optional)" className="bg-card" />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
          <p className="text-xs text-muted-foreground">Every bidder is told the result. The other bids stay on file.</p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={award} disabled={!ready || isAwarding}>
              {isAwarding ? "Awarding…" : `${priceBook ? "Add to price book" : "Award"} · ${formatMoneyCents(contractCents)}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Line({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-3", strong ? "text-base font-semibold" : "text-sm", muted && "text-muted-foreground")}>
      <span>{label}</span>
      <span className={cn(!muted && "font-mono tabular-nums")}>{value}</span>
    </div>
  )
}

function Gate({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
      <span className={ok ? "text-muted-foreground" : undefined}>{label}</span>
    </div>
  )
}
