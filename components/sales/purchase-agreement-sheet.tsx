"use client"

import { useRouter } from "next/navigation"
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react"

import {
  createPurchaseAgreementAction,
  getAgreementDraftContextAction,
  priceAgreementDraftAction,
} from "@/app/(app)/sales/actions"
import { AlertTriangle, Check } from "@/components/icons"
import { Field, Picker, Section } from "@/components/sales/registration-fields"
import { ConfigurationIssues } from "@/components/selections/configuration-issues"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"
import type {
  AgreementCatalogItem,
  AgreementDraftContext,
  AgreementDraftPricing,
} from "@/lib/services/community-sales"
import { agreementChoiceKey, indexAgreementCatalog, pageAgreementCatalog } from "@/lib/sales/agreement-catalog"
import type { ConfigurationFix } from "@/lib/selections/configuration-fixes"
import type { ConfigurationViolation } from "@/lib/selections/configuration-rules"
import { cn, formatMoneyCents } from "@/lib/utils"

type ConfigurationIssueSet = { violations: ConfigurationViolation[]; fixes: ConfigurationFix[] }

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
    setVersionId("")
    setElevationId("")
    setSwing("")
    setPricing(null)
    setPricedConfigurationKey(null)
    setPriceError(null)
    setEffectiveDate(localDay())
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
  const canSubmit = Boolean(open && context?.reservationId === reservationId && configuration && currentPricing?.quoteHash && !missingEmail)

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
    if (!context || !configuration || !pricing || !canSubmit || committedView.current !== viewToken || submittingView.current === viewToken) return
    submittingView.current = viewToken
    const isCurrent = () => committedView.current === viewToken
    startTransition(async () => {
      try {
        const result = await createPurchaseAgreementAction({
          ...configuration,
          reservationId: context.reservationId,
          expectedQuoteHash: pricing.quoteHash,
          terms: terms.trim() || null,
          effectiveDate,
        })
        if (!isCurrent()) return
        if (!result.success && result.code === "AGREEMENT_QUOTE_CHANGED") {
          setPricing(null)
          setPricedConfigurationKey(null)
          setQuoteRefresh(previous => previous + 1)
        }
        const agreement = unwrapAction(result)
        const sent = Boolean(agreement.signing.documentId && agreement.signing.envelopeId && !agreement.signing.reason)
        toast({
          title: sent ? "Agreement sent for signature" : "Agreement saved",
          description: sent ? "Buyer invitations were accepted for email delivery." : agreement.signing.reason ?? "Signing needs attention before invitations can be sent.",
        })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        if (isCurrent()) toast({ title: "Could not write the agreement", description: (error as Error).message })
      } finally {
        if (submittingView.current === viewToken) submittingView.current = null
      }
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
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
          {currentLoadError ? (
            <Notice tone="destructive" title="Cannot write an agreement yet" body={currentLoadError} />
          ) : !context ? (
            <LoadingBody />
          ) : (
            <div className="divide-y">
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
                <Field label="Additional terms" htmlFor="agreement-terms">
                  <Textarea
                    id="agreement-terms"
                    rows={4}
                    value={terms}
                    onChange={(event) => setTerms(event.target.value)}
                    placeholder="Contingent on the buyer's lender clearing by…"
                    className="resize-none rounded-none text-[13px]"
                  />
                </Field>
              </Section>
            </div>
          )}
          </fieldset>
        </ScrollArea>

        <div className="border-t px-5 py-3">
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
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t px-5 py-3">
          <Button variant="outline" size="sm" className="rounded-none" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" className="rounded-none" onClick={create} disabled={pending || !canSubmit}>
            {pending ? "Sending…" : "Write & send for signature"}
          </Button>
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
}: {
  tone: "destructive"
  title: string
  body: string
}) {
  return (
    <div
      className={cn(
        "border-l-2 px-5 py-4",
        tone === "destructive" && "border-l-destructive bg-destructive/5",
      )}
    >
      <p className="text-[13px] font-medium text-destructive">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{body}</p>
    </div>
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
