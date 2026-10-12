"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react"

import {
  createPurchaseAgreementAction,
  getAgreementDraftContextAction,
  previewAgreementPacketAction,
  priceAgreementDraftAction,
} from "@/app/(app)/sales/actions"
import { AlertTriangle, Check, Lock, Plus, X } from "@/components/icons"
import { AgreementCommissionSigningHold } from "@/components/sales/agreement-commission-plan"
import { Field, Picker, Section } from "@/components/sales/registration-fields"
import { ConfigurationIssues } from "@/components/selections/configuration-issues"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import { homePriceAdjustments } from "@/lib/financials/purchase-agreement-pricing"
import type {
  AgreementCatalogItem,
  AgreementDraftContext,
  AgreementDraftPricing,
} from "@/lib/services/community-sales"
import { agreementChoiceKey, indexAgreementCatalog, pageAgreementCatalog } from "@/lib/sales/agreement-catalog"
import { CONTINGENCY_KINDS, MILESTONE_KIND_LABELS, type ContingencyKind } from "@/lib/sales/agreement-milestones"
import type { AgreementContingencyTerm } from "@/lib/validation/community-sales"
import type { ResolvedAgreementPacket } from "@/lib/sales/agreement-packet"
import type { ConfigurationFix } from "@/lib/selections/configuration-fixes"
import type { ConfigurationViolation } from "@/lib/selections/configuration-rules"
import { cn, formatMoneyCents } from "@/lib/utils"

type ConfigurationIssueSet = { violations: ConfigurationViolation[]; fixes: ConfigurationFix[] }

/** A contingency row as typed; it becomes a signed term only once it is complete. */
type ContingencyDraft = {
  id: number
  kind: ContingencyKind
  title: string
  requiredBefore: "start" | "closing"
  dueInDays: string
  dueOn: string
  evidenceRequired: boolean
}

function isContingencyKind(value: string): value is ContingencyKind {
  return CONTINGENCY_KINDS.some((kind) => kind === value)
}

/** The signed terms, or the first reason a row is not one yet. */
function contingencyTerms(rows: ContingencyDraft[]): { terms: AgreementContingencyTerm[] } | { missing: string } {
  const terms: AgreementContingencyTerm[] = []
  for (const row of rows) {
    const title = row.title.trim()
    if (!title) return { missing: "Name each contingency." }
    const days = row.dueInDays.trim()
    if (days && !/^\d{1,3}$/.test(days)) return { missing: `Give "${title}" a whole number of days.` }
    if (!days && !row.dueOn) return { missing: `Give "${title}" a deadline.` }
    terms.push({
      kind: row.kind, title, required_before: row.requiredBefore, evidence_required: row.evidenceRequired,
      ...(days ? { due_in_days: Number(days) } : { due_on: row.dueOn }),
    })
  }
  return { terms }
}

/** A selected catalog line, keyed the way `optionItems` wants it. */
type Pick = { optionId?: string; packageId?: string }

function keyOf(item: Pick): string {
  return agreementChoiceKey(item)
}

function localDay(): string {
  const now = new Date()
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

/**
 * Writing the purchase agreement — the transition that turns a reserved lot into
 * a sale, and the one the desk had no way to make at all.
 *
 * The configuration is the contract, so this form is the price: every toggle
 * re-prices against the community's real base price, lot premium, option catalog
 * and live incentives rather than anything typed by hand. Saving writes the draft
 * and emails it to the buyer for signature; the countersigned envelope is what
 * later flips the deal to under contract, so nothing here declares the sale won.
 */
export function PurchaseAgreementSheet({
  reservationId,
  open,
  onOpenChange,
}: {
  reservationId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [pending, startTransition] = useTransition()
  const viewToken = useMemo(() => ({ open, reservationId }), [open, reservationId])
  const committedView = useRef<typeof viewToken | null>(null)
  const submittingView = useRef<typeof viewToken | null>(null)
  useLayoutEffect(() => {
    committedView.current = viewToken
    return () => { if (committedView.current === viewToken) committedView.current = null }
  }, [viewToken])

  const [loadedContext, setContext] = useState<AgreementDraftContext | null>(null)
  const [loadedView, setLoadedView] = useState<typeof viewToken | null>(null)
  const context = open && loadedView === viewToken && loadedContext?.reservationId === reservationId ? loadedContext : null
  const [loadError, setLoadError] = useState<{ view: typeof viewToken; message: string } | null>(null)
  const currentLoadError = loadError?.view === viewToken ? loadError.message : null
  const [versionId, setVersionId] = useState("")
  const [elevationId, setElevationId] = useState("")
  const [swing, setSwing] = useState<"left" | "right" | "">("")
  const pricingGeneration = useRef(0)
  const [pricedConfigurationKey, setPricedConfigurationKey] = useState<string | null>(null)
  const [pricedView, setPricedView] = useState<typeof viewToken | null>(null)
  const [picks, setPicks] = useState<Pick[]>([])
  const [incentiveIds, setIncentiveIds] = useState<string[]>([])
  const [terms, setTerms] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(localDay())
  const [financing, setFinancing] = useState<"cash" | "financed" | "">("")
  const [contingencies, setContingencies] = useState<ContingencyDraft[]>([])
  const [optionalAddenda, setOptionalAddenda] = useState<string[]>([])
  const [packet, setPacket] = useState<{ view: typeof viewToken; key: string; value: ResolvedAgreementPacket } | null>(null)
  const [packetError, setPacketError] = useState<{ view: typeof viewToken; key: string; message: string } | null>(null)
  const [packetRefresh, setPacketRefresh] = useState(0)
  /** A draft saved without going out for signature: the sheet stays open on its commission hold. */
  const [held, setHeld] = useState<{ view: typeof viewToken; contractId: string; projectId: string; reason: string | null } | null>(null)

  const [pricing, setPricing] = useState<AgreementDraftPricing | null>(null)
  const [priceError, setPriceError] = useState<{ view: typeof viewToken; key: string; generation: number; message: string; issues: ConfigurationIssueSet | null } | null>(null)
  const [pricingBusy, setPricingBusy] = useState(false)
  const [quoteRefresh, setQuoteRefresh] = useState(0)

  useEffect(() => {
    setContext(null)
    setLoadedView(null)
    setLoadError(null)
    setPicks([])
    setIncentiveIds([])
    setTerms("")
    setOptionalAddenda([])
    setPacket(null)
    setPacketError(null)
    setVersionId("")
    setElevationId("")
    setSwing("")
    setPricing(null)
    setPricedConfigurationKey(null)
    setPriceError(null)
    setEffectiveDate(localDay())
    setFinancing("")
    setContingencies([])
    setHeld(null)
    if (!open) return
    let cancelled = false
    getAgreementDraftContextAction(reservationId)
      .then((result) => {
        if (cancelled || committedView.current !== viewToken) return
        const data = unwrapAction(result)
        if (data.reservationId !== reservationId) throw new Error("The reservation changed while loading. Reopen the agreement.")
        setContext(data)
        setLoadedView(viewToken)
        setVersionId(data.pinnedVersionId ?? data.versions.find((v) => v.isPinned)?.id ?? data.versions[0]?.id ?? "")
        setElevationId(data.pinnedElevationId ?? (data.elevations.length === 1 ? data.elevations[0].id : ""))
        setSwing(data.swing === "left" || data.swing === "right" ? data.swing : "")
      })
      .catch((error: Error) => {
        if (!cancelled && committedView.current === viewToken) setLoadError({ view: viewToken, message: error.message })
      })
    return () => {
      cancelled = true
    }
  }, [open, reservationId, viewToken])

  const designCatalog = useMemo(() => context ? [...context.packages, ...context.designSelections] : [], [context])

  const configuration = useMemo(
    () =>
      context
        ? {
            lotId: context.lotId,
            ...(versionId ? { housePlanVersionId: versionId } : {}),
            elevationId: elevationId || null,
            ...(swing ? { swing } : {}),
            optionItems: picks,
            incentiveIds,
          }
        : null,
    [context, versionId, elevationId, swing, picks, incentiveIds],
  )

  // Tie every quote to the exact configuration and ignore late responses.
  useEffect(() => {
    const generation = ++pricingGeneration.current
    const invalidateGeneration = () => {
      if (pricingGeneration.current === generation) pricingGeneration.current++
    }
    setPricing(null)
    setPricedConfigurationKey(null)
    setPricedView(null)
    setPriceError(null)
    if (!configuration) { setPricingBusy(false); return }
    setPricingBusy(true)
    const key = JSON.stringify(configuration)
    const timer = setTimeout(async () => {
      try {
        const result = await priceAgreementDraftAction(configuration)
        if (pricingGeneration.current !== generation) return
        if (!result.success && result.violations?.length) {
          setPriceError({ view: viewToken, key, generation, message: result.error, issues: { violations: result.violations, fixes: result.fixes ?? [] } })
          return
        }
        setPricing(unwrapAction(result))
        setPricedConfigurationKey(key)
        setPricedView(viewToken)
      } catch (error) {
        if (pricingGeneration.current === generation) setPriceError({ view: viewToken, key, generation, message: (error as Error).message, issues: null })
      } finally {
        if (pricingGeneration.current === generation) setPricingBusy(false)
      }
    }, 250)
    return () => { clearTimeout(timer); invalidateGeneration() }
  }, [configuration, quoteRefresh, viewToken])

  // The documents follow the optional addenda picked; required ones are always in.
  const packetKey = JSON.stringify([...optionalAddenda].sort())
  useEffect(() => {
    if (!context?.packet) return
    let cancelled = false
    const key = packetKey
    previewAgreementPacketAction({ lotId: context.lotId, optionalAddendumTemplateIds: JSON.parse(key) })
      .then((result) => {
        if (cancelled || committedView.current !== viewToken) return
        if (!result.success) { setPacketError({ view: viewToken, key, message: result.error }); return }
        setPacket({ view: viewToken, key, value: result.data.packet })
        setPacketError(null)
      })
      .catch((error: Error) => { if (!cancelled) setPacketError({ view: viewToken, key, message: error.message }) })
    return () => { cancelled = true }
  }, [context, packetKey, packetRefresh, viewToken])

  const toggleAddendum = (templateId: string) => {
    setOptionalAddenda((previous) => previous.includes(templateId) ? previous.filter((entry) => entry !== templateId) : [...previous, templateId])
  }

  const togglePick = (item: Pick) => {
    setPicks((previous) =>
      previous.some((entry) => keyOf(entry) === keyOf(item))
        ? previous.filter((entry) => keyOf(entry) !== keyOf(item))
        : [...previous, item],
    )
  }

  /** A correction edits the draft lines; the re-quote it triggers re-checks every rule on the server. */
  const applyFix = (fix: ConfigurationFix) => {
    const removed = fix.remove ? keyOf(fix.remove) : null
    const added = fix.add ? { optionId: fix.add.optionId } : null
    setPicks((previous) => {
      const kept = previous.filter((entry) => keyOf(entry) !== removed)
      return added && !kept.some((entry) => keyOf(entry) === keyOf(added)) ? [...kept, added] : kept
    })
  }

  const toggleIncentive = (id: string) => {
    setIncentiveIds((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id],
    )
  }

  const configurationKey = configuration ? JSON.stringify(configuration) : null
  const currentPricing = configurationKey !== null && pricedView === viewToken && pricedConfigurationKey === configurationKey && !pricingBusy ? pricing : null
  const currentChoicePrices = currentPricing?.choicePrices ?? null
  const currentPriceError = priceError?.view === viewToken && priceError.key === configurationKey ? priceError.message : null
  const currentIssues = currentPriceError ? priceError?.issues ?? null : null
  const missingEmail = context !== null && !context.buyerEmail
  const currentPacket = packet?.view === viewToken && packet.key === packetKey ? packet.value : null
  const currentPacketError = packetError?.view === viewToken && packetError.key === packetKey ? packetError.message : null
  const signedTerms = contingencyTerms(contingencies)
  const canSubmit = Boolean(open && context?.reservationId === reservationId && configuration && currentPricing?.quoteHash && currentPacket && !missingEmail
    && financing && "terms" in signedTerms)

  const refreshQuote = () => {
    if (!priceError || !configuration || pending || pricingBusy || committedView.current !== viewToken
      || priceError.view !== viewToken || priceError.key !== configurationKey || priceError.generation !== pricingGeneration.current) return
    pricingGeneration.current++ // Coalesce duplicate clicks and invalidate obsolete retry handlers.
    setPricing(null)
    setPricedConfigurationKey(null)
    setPriceError(null)
    setQuoteRefresh(previous => previous + 1)
  }

  const create = () => {
    if (!context || !configuration || !pricing || !currentPacket || !financing || !("terms" in signedTerms) || !canSubmit
      || committedView.current !== viewToken || submittingView.current === viewToken) return
    submittingView.current = viewToken
    const isCurrent = () => committedView.current === viewToken
    startTransition(async () => {
      try {
        const result = await createPurchaseAgreementAction({
          ...configuration,
          reservationId: context.reservationId,
          expectedQuoteHash: pricing.quoteHash,
          optionalAddendumTemplateIds: optionalAddenda,
          expectedPacketHash: currentPacket.hash,
          terms: terms.trim() || null,
          effectiveDate,
          financing,
          contingencies: signedTerms.terms,
        })
        if (!isCurrent()) return
        if (!result.success && result.code === "AGREEMENT_QUOTE_CHANGED") {
          setPricing(null)
          setPricedConfigurationKey(null)
          setQuoteRefresh(previous => previous + 1)
        }
        if (!result.success && result.code === "AGREEMENT_PACKET_CHANGED") {
          setPacket(null)
          setPacketRefresh(previous => previous + 1)
        }
        const agreement = unwrapAction(result)
        const sent = Boolean(agreement.signing.documentId && agreement.signing.envelopeId && !agreement.signing.reason)
        if (sent || agreement.status !== "draft") {
          toast({
            title: sent ? "Agreement sent for signature" : "Agreement saved",
            description: sent ? "Buyer invitations were accepted for email delivery." : agreement.signing.reason ?? "Signing needs attention before invitations can be sent.",
          })
          onOpenChange(false)
          router.refresh()
          return
        }
        setHeld({ view: viewToken, contractId: agreement.id, projectId: agreement.project_id, reason: agreement.signing.reason })
      } catch (error) {
        if (isCurrent()) toast({ title: "Could not write the agreement", description: (error as Error).message })
      } finally {
        if (submittingView.current === viewToken) submittingView.current = null
      }
    })
  }

  const currentHeld = held?.view === viewToken ? held : null
  const close = () => {
    onOpenChange(false)
    if (currentHeld) router.refresh()
  }

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) close(); else onOpenChange(next) }}>
      <SheetContent side="right" mobileFullscreen className="flex w-full flex-col gap-0 rounded-none p-0 sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b px-5 py-4 text-left">
          <SheetTitle className="text-base font-semibold">Purchase agreement</SheetTitle>
          <SheetDescription className="text-xs">
            {context
              ? `${context.buyerName ?? "Buyer"}${context.lotLabel ? ` · Lot ${context.lotLabel}` : ""}${
                  context.planLabel ? ` · ${context.planLabel}` : ""
                }`
              : "The configuration is the contract — every line prices off the community sheet."}
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <fieldset disabled={pending} className="min-w-0 border-0 p-0">
          {currentHeld ? (
            <div className="divide-y">
              <Notice tone="warning" title="Agreement saved; not sent yet" body={currentHeld.reason ?? "Signing needs attention before invitations can be sent."} />
              <Section title="Commissions" hint="The agreement goes out for signature once its commissions are approved or declared none.">
                <AgreementCommissionSigningHold contractId={currentHeld.contractId} projectId={currentHeld.projectId} onResumed={close} />
              </Section>
            </div>
          ) : currentLoadError ? (
            <Notice tone="destructive" title="Cannot write an agreement yet" body={currentLoadError} />
          ) : !context ? (
            <LoadingBody />
          ) : (
            <div className="divide-y">
              {context.packetRefusal ? (
                <Notice
                  tone="destructive"
                  title="No agreement documents for this home"
                  body={context.packetRefusal}
                  action={<Link href="/settings/templates?section=agreements" className="text-xs font-medium underline underline-offset-2">Open agreement templates</Link>}
                />
              ) : null}
              {missingEmail ? (
                <Notice
                  tone="destructive"
                  title="The buyer has no email address"
                  body="The agreement is emailed for signature, so add an email to the buyer under Edit deal before writing it."
                />
              ) : null}

              <Section
                title="The home"
                hint={
                  context.pinnedVersionId
                    ? "This is a spec home — its plan version is pinned and cannot change."
                    : "Only released plan versions can be sold."
                }
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Plan version">
                    <Picker
                      value={versionId}
                      onChange={setVersionId}
                      placeholder="Choose a version"
                      disabled={pending || Boolean(context.pinnedVersionId) || context.versions.length <= 1}
                      options={context.versions.map((version) => ({
                        value: version.id,
                        label: version.isPinned ? `${version.label} · on the lot` : version.label,
                      }))}
                    />
                  </Field>
                  <Field label="Elevation">
                    <Picker
                      value={elevationId}
                      onChange={setElevationId}
                      disabled={pending || Boolean(context.pinnedElevationId)}
                      placeholder={context.elevationLabel ?? "Base"}
                      options={context.elevations.map((row) => ({ value: row.id, label: row.label }))}
                    />
                  </Field>
                </div>
                <Field label="Swing" required>
                  <Picker value={swing} onChange={(value) => { if (value === "" || value === "left" || value === "right") setSwing(value) }}
                    disabled={pending || context.swing === "left" || context.swing === "right"}
                    placeholder="Choose left or right"
                    options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} />
                </Field>
              </Section>

              <CatalogSection
                title="Structural options"
                hint="Chosen now because they change the build, not the finishes."
                items={context.structuralOptions}
                picks={picks}
                quotedPrices={currentChoicePrices}
                quoteFailed={Boolean(currentPriceError)}
                onToggle={togglePick}
              />

              <CatalogSection
                title="Design selections"
                hint="Anything left blank is chosen later in Design Studio, at the price sheet in force then."
                items={designCatalog}
                picks={picks}
                quotedPrices={currentChoicePrices}
                quoteFailed={Boolean(currentPriceError)}
                onToggle={togglePick}
              />

              {context.incentives.length > 0 ? (
                <Section title="Incentives" hint="Only incentives that are live today can be applied.">
                  <div className="space-y-1">
                    {context.incentives.map((incentive) => (
                      <Row
                        key={incentive.id}
                        label={incentive.name}
                        meta={incentive.summary}
                        selected={incentiveIds.includes(incentive.id)}
                        onToggle={() => toggleIncentive(incentive.id)}
                      />
                    ))}
                  </div>
                </Section>
              ) : null}

              {context.packet ? (
                <PacketSection
                  offered={context.packet.optional_offered}
                  packet={currentPacket}
                  error={currentPacketError}
                  picked={optionalAddenda}
                  onToggle={toggleAddendum}
                />
              ) : null}

              <ContingencySection
                financing={financing}
                onFinancing={setFinancing}
                rows={contingencies}
                onRows={setContingencies}
                missing={"missing" in signedTerms ? signedTerms.missing : null}
              />

              <Section title="Terms">
                <Field label="Effective date" htmlFor="agreement-effective">
                  <Input
                    id="agreement-effective"
                    type="date"
                    value={effectiveDate}
                    onChange={(event) => setEffectiveDate(event.target.value)}
                    className="h-9 rounded-none tabular-nums"
                  />
                </Field>
                <Field label="Special stipulations" htmlFor="agreement-terms">
                  <Textarea
                    id="agreement-terms"
                    rows={4}
                    value={terms}
                    onChange={(event) => setTerms(event.target.value)}
                    placeholder="Printed on Schedule A. Buyer-specific terms only; the agreement text comes from your templates."
                    className="resize-none rounded-none text-[13px]"
                  />
                </Field>
              </Section>
            </div>
          )}
          </fieldset>
        </ScrollArea>

        {currentHeld ? null : <div className="border-t px-5 py-3">
          {currentIssues ? (
            <div className="-mx-5 -my-3">
              <ConfigurationIssues
                violations={currentIssues.violations}
                fixes={currentIssues.fixes}
                disabled={pending || pricingBusy}
                changeOrderHint="Change the draft lines above instead."
                onApply={applyFix}
              />
            </div>
          ) : currentPriceError ? (
            <div className="space-y-2">
              <p className="flex items-start gap-2 text-[11px] text-destructive" role="alert">
                <AlertTriangle className="mt-px size-3.5 shrink-0" />
                <span>{currentPriceError}</span>
              </p>
              <Button size="sm" variant="outline" disabled={pending || pricingBusy} onClick={refreshQuote}>Refresh quote</Button>
            </div>
          ) : currentPricing ? (
            <PriceSummary pricing={currentPricing} />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              {context ? "Pricing…" : "Loading the community price sheet…"}
            </p>
          )}
        </div>}

        <SheetFooter className="flex-row justify-end gap-2 border-t px-5 py-3">
          {currentHeld ? (
            <Button size="sm" className="rounded-none" onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" size="sm" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" className="rounded-none" onClick={create} disabled={pending || !canSubmit}>
                {pending ? "Sending…" : "Write & send for signature"}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function PriceSummary({ pricing }: { pricing: AgreementDraftPricing }) {
  const options = pricing.structuralOptionsCents + pricing.designSelectionsCents
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold">Contract price</span>
        <span className="font-semibold tabular-nums">{formatMoneyCents(pricing.totalCents)}</span>
      </div>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        Base {formatMoneyCents(pricing.basePriceCents)}
        {pricing.lotPremiumCents > 0 ? ` · premium ${formatMoneyCents(pricing.lotPremiumCents)}` : ""}
        {options > 0 ? ` · options ${formatMoneyCents(options)}` : ""}
        {pricing.incentivesCents > 0 ? ` · incentives −${formatMoneyCents(pricing.incentivesCents)}` : ""}
        {homePriceAdjustments(pricing).map((line) => ` · ${line.label.toLowerCase()} ${line.amountCents < 0 ? "−" : "+"}${formatMoneyCents(Math.abs(line.amountCents))}`).join("")}
      </p>
    </div>
  )
}

function CatalogSection({
  title,
  hint,
  items,
  picks,
  quotedPrices,
  quoteFailed,
  onToggle,
}: {
  title: string
  hint: string
  items: AgreementCatalogItem[]
  picks: Pick[]
  quotedPrices?: Array<Pick & { priceCents: number }> | null
  quoteFailed?: boolean
  onToggle: (item: Pick) => void
}) {
  const [query, setQuery] = useState("")
  const [selectedOnly, setSelectedOnly] = useState(false)
  const [page, setPage] = useState(0)
  const index = useMemo(() => indexAgreementCatalog(items), [items])
  const selected = useMemo(() => new Set(picks.map(keyOf)), [picks])
  const quotes = useMemo(() => new Map((quotedPrices ?? []).map(choice => [keyOf(choice), choice.priceCents])), [quotedPrices])
  const view = useMemo(() => pageAgreementCatalog(index, selected, { query, selectedOnly, page }), [index, selected, query, selectedOnly, page])
  if (items.length === 0) {
    return (
      <Section title={title}>
        <p className="text-xs text-muted-foreground">Nothing in the catalog for this community yet.</p>
      </Section>
    )
  }
  return (
    <Section title={view.selectedCount > 0 ? `${title} · ${view.selectedCount}` : title} hint={hint}>
      <div className="flex items-center gap-2">
        <Input type="search" value={query} aria-label={`Search ${title.toLowerCase()}`}
          placeholder="Search names or categories" className="h-9 min-w-0 flex-1 text-xs"
          onChange={(event) => { setQuery(event.target.value); setPage(0) }} />
        <Button type="button" variant={selectedOnly ? "secondary" : "outline"} size="sm" aria-pressed={selectedOnly}
          aria-label={`Show selected ${title.toLowerCase()}`}
          onClick={() => { setSelectedOnly(previous => !previous); setPage(0) }}>
          Selected ({view.selectedCount})
        </Button>
      </div>
      <div className="space-y-1">
        {view.items.map((item) => {
          const key = keyOf(item)
          const picked = selected.has(key)
          const quotedPrice = quotes.get(key)
          const amount = !picked ? `Catalog ${formatMoneyCents(item.priceCents)}`
            : quotedPrice !== undefined ? `Quoted ${formatMoneyCents(quotedPrice)}`
            : quoteFailed ? "Not priced" : "Pricing…"
          return <Row key={key} label={item.label}
            meta={[item.category, amount].filter(Boolean).join(" · ")}
            selected={picked}
            onToggle={() => onToggle(item.optionId ? { optionId: item.optionId } : { packageId: item.packageId })} />
        })}
        {view.matchesCount === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">
            {selectedOnly ? "No selected options match this search." : "No options match this search."}
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span role="status" aria-live="polite">{view.start}–{view.end} of {view.matchesCount} · {items.length} in catalog</span>
        {view.pages > 1 ? (
          <div className="flex items-center gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={view.page === 0}
              aria-label={`Previous ${title.toLowerCase()} page`} onClick={() => setPage(view.page - 1)}>Previous</Button>
            <Button type="button" variant="ghost" size="sm" disabled={view.page + 1 >= view.pages}
              aria-label={`Next ${title.toLowerCase()} page`} onClick={() => setPage(view.page + 1)}>Next</Button>
          </div>
        ) : null}
      </div>
    </Section>
  )
}

function Row({
  label,
  meta,
  selected,
  onToggle,
}: {
  label: string
  meta: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-center gap-3 border px-2.5 py-2 text-left transition-colors",
        selected ? "border-foreground bg-muted/50" : "border-transparent hover:bg-muted/45",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center border",
          selected ? "border-foreground bg-foreground text-background" : "border-border",
        )}
      >
        {selected ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{meta}</span>
    </button>
  )
}

function Notice({
  tone,
  title,
  body,
  action,
}: {
  tone: "destructive" | "warning"
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div
      className={cn(
        "border-l-2 px-5 py-4",
        tone === "destructive" && "border-l-destructive bg-destructive/5",
        tone === "warning" && "border-l-warning bg-warning/10",
      )}
    >
      <p className={cn("text-[13px] font-medium", tone === "destructive" ? "text-destructive" : "text-foreground")}>{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

/**
 * The documents the buyer will sign: the base agreement and required addenda
 * are fixed by the home's community and state; optional addenda are the
 * seller's pick. Version numbers are what the signature binds.
 */
function PacketSection({
  offered,
  packet,
  error,
  picked,
  onToggle,
}: {
  offered: ResolvedAgreementPacket["optional_offered"]
  packet: ResolvedAgreementPacket | null
  error: string | null
  picked: string[]
  onToggle: (templateId: string) => void
}) {
  const required = packet?.documents.filter((document) => document.required) ?? []
  return (
    <Section title="Agreement documents" hint={packet?.jurisdiction ? `Published for ${packet.jurisdiction}. The buyer signs these exact versions.` : "The buyer signs these exact versions."}>
      {error ? (
        <p className="flex items-start gap-2 text-[11px] text-destructive" role="alert">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : !packet ? (
        <div className="space-y-1">
          {[0, 1].map((row) => <Skeleton key={row} className="h-9 w-full rounded-none" />)}
        </div>
      ) : (
        <div className="space-y-1">
          {required.map((document) => (
            <div key={document.template_id} className="flex items-center gap-3 border border-transparent px-2.5 py-2">
              <Lock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{document.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {document.kind === "agreement" ? "Agreement" : "Required"} · v{document.version_number}
              </span>
            </div>
          ))}
          {offered.map((addendum) => (
            <Row
              key={addendum.template_id}
              label={addendum.title}
              meta="Optional addendum"
              selected={picked.includes(addendum.template_id)}
              onToggle={() => onToggle(addendum.template_id)}
            />
          ))}
        </div>
      )}
    </Section>
  )
}

/**
 * How the buyer pays and what the sale is contingent on. Both print on
 * Schedule A; when the agreement executes, each contingency becomes a tracked
 * milestone with this deadline, and a financed sale also gets the lender and
 * title milestones.
 */
function ContingencySection({
  financing,
  onFinancing,
  rows,
  onRows,
  missing,
}: {
  financing: "cash" | "financed" | ""
  onFinancing: (value: "cash" | "financed" | "") => void
  rows: ContingencyDraft[]
  onRows: (rows: ContingencyDraft[]) => void
  missing: string | null
}) {
  const update = (id: number, patch: Partial<ContingencyDraft>) => onRows(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  const add = () => onRows([...rows, {
    id: rows.reduce((max, row) => Math.max(max, row.id), 0) + 1, kind: "financing", title: MILESTONE_KIND_LABELS.financing,
    requiredBefore: "closing", dueInDays: "30", dueOn: "", evidenceRequired: true,
  }])
  return (
    <Section title="Financing and contingencies" hint="Printed on Schedule A. Each contingency is tracked against its deadline once the agreement is signed.">
      <Field label="Financing" required>
        <Picker value={financing} onChange={(value) => { if (value === "" || value === "cash" || value === "financed") onFinancing(value) }}
          placeholder="Cash or financed"
          options={[{ value: "financed", label: "Financed — lender and title milestones are tracked" }, { value: "cash", label: "Cash — title commitment only" }]} />
      </Field>
      {rows.length ? (
        <div className="space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="space-y-2 border px-2.5 py-2">
              <div className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-center">
                <Picker value={row.kind} placeholder="Kind"
                  onChange={(value) => { if (isContingencyKind(value)) update(row.id, { kind: value, title: row.title === MILESTONE_KIND_LABELS[row.kind] ? MILESTONE_KIND_LABELS[value] : row.title }) }}
                  options={CONTINGENCY_KINDS.map((kind) => ({ value: kind, label: MILESTONE_KIND_LABELS[kind] }))} />
                <Input aria-label="Contingency" value={row.title} maxLength={200} onChange={(event) => update(row.id, { title: event.target.value })}
                  className="h-9 rounded-none text-[13px]" />
                <Button type="button" variant="ghost" size="sm" aria-label={`Remove ${row.title || "contingency"}`}
                  onClick={() => onRows(rows.filter((entry) => entry.id !== row.id))}>
                  <X className="size-3.5" />
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[7rem_9rem_1fr] sm:items-center">
                <Input aria-label="Days after signing" inputMode="numeric" placeholder="Days" value={row.dueInDays}
                  onChange={(event) => update(row.id, { dueInDays: event.target.value, dueOn: event.target.value ? "" : row.dueOn })}
                  className="h-9 rounded-none tabular-nums" />
                <Input aria-label="Or a date" type="date" value={row.dueOn}
                  onChange={(event) => update(row.id, { dueOn: event.target.value, dueInDays: event.target.value ? "" : row.dueInDays })}
                  className="h-9 rounded-none tabular-nums" />
                <Picker value={row.requiredBefore} placeholder="Holds"
                  onChange={(value) => { if (value === "start" || value === "closing") update(row.id, { requiredBefore: value }) }}
                  options={[{ value: "closing", label: "Holds closing" }, { value: "start", label: "Holds the start" }]} />
              </div>
              <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <Checkbox checked={row.evidenceRequired} onCheckedChange={(checked) => update(row.id, { evidenceRequired: checked === true })} />
                Satisfied only with a written document attached
              </label>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No contingencies. The sale is firm once signed{financing === "financed" ? ", apart from the lender and title milestones" : ""}.</p>
      )}
      <div className="flex items-center justify-between gap-3">
        <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={add} disabled={rows.length >= 20}>
          <Plus className="size-3.5" />
          Add contingency
        </Button>
        {missing ? <p className="text-[11px] text-destructive" role="alert">{missing}</p> : null}
      </div>
    </Section>
  )
}

function LoadingBody() {
  return (
    <div className="space-y-6 px-5 py-4">
      {[0, 1, 2].map((block) => (
        <div key={block} className="space-y-2">
          <Skeleton className="h-2.5 w-24 rounded-none" />
          {Array.from({ length: 3 }).map((_, row) => (
            <Skeleton key={row} className="h-9 w-full rounded-none" />
          ))}
        </div>
      ))}
    </div>
  )
}
