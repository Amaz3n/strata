"use client"

import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useState, useTransition } from "react"

import {
  createPurchaseAgreementAction,
  getAgreementDraftContextAction,
  priceAgreementDraftAction,
} from "@/app/(app)/sales/actions"
import { AlertTriangle, Check } from "@/components/icons"
import { Field, Picker, Section } from "@/components/sales/registration-fields"
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
import { cn, formatMoneyCents } from "@/lib/utils"

/** A selected catalog line, keyed the way `optionItems` wants it. */
type Pick = { optionId?: string; packageId?: string }

function keyOf(item: Pick): string {
  return item.optionId ?? item.packageId ?? ""
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

  const [context, setContext] = useState<AgreementDraftContext | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [versionId, setVersionId] = useState("")
  const [elevationId, setElevationId] = useState("")
  const [picks, setPicks] = useState<Pick[]>([])
  const [incentiveIds, setIncentiveIds] = useState<string[]>([])
  const [terms, setTerms] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(localDay())

  const [pricing, setPricing] = useState<AgreementDraftPricing | null>(null)
  const [priceError, setPriceError] = useState<string | null>(null)
  const [pricingBusy, setPricingBusy] = useState(false)

  useEffect(() => {
    if (!open) {
      setContext(null)
      setLoadError(null)
      setPicks([])
      setIncentiveIds([])
      setTerms("")
      setPricing(null)
      setPriceError(null)
      setEffectiveDate(localDay())
      return
    }
    let cancelled = false
    getAgreementDraftContextAction(reservationId)
      .then((result) => {
        if (cancelled) return
        const data = unwrapAction(result)
        setContext(data)
        setVersionId(data.pinnedVersionId ?? data.versions.find((v) => v.isPinned)?.id ?? data.versions[0]?.id ?? "")
        setElevationId(data.elevations.length === 1 ? data.elevations[0].id : "")
      })
      .catch((error: Error) => {
        if (!cancelled) setLoadError(error.message)
      })
    return () => {
      cancelled = true
    }
  }, [open, reservationId])

  const configuration = useMemo(
    () =>
      context
        ? {
            lotId: context.lotId,
            ...(versionId ? { housePlanVersionId: versionId } : {}),
            ...(elevationId ? { elevationId } : {}),
            optionItems: picks,
            incentiveIds,
          }
        : null,
    [context, versionId, elevationId, picks, incentiveIds],
  )

  // Re-prices on every change. Debounced because toggling ten options in a row
  // should cost one round trip, not ten.
  const reprice = useCallback(async (input: NonNullable<typeof configuration>) => {
    setPricingBusy(true)
    try {
      const result = await priceAgreementDraftAction(input)
      setPricing(unwrapAction(result))
      setPriceError(null)
    } catch (error) {
      setPricing(null)
      setPriceError((error as Error).message)
    } finally {
      setPricingBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!configuration) return
    const timer = setTimeout(() => void reprice(configuration), 250)
    return () => clearTimeout(timer)
  }, [configuration, reprice])

  const togglePick = (item: Pick) => {
    setPicks((previous) =>
      previous.some((entry) => keyOf(entry) === keyOf(item))
        ? previous.filter((entry) => keyOf(entry) !== keyOf(item))
        : [...previous, item],
    )
  }

  const toggleIncentive = (id: string) => {
    setIncentiveIds((previous) =>
      previous.includes(id) ? previous.filter((entry) => entry !== id) : [...previous, id],
    )
  }

  const missingEmail = context !== null && !context.buyerEmail
  const canSubmit = Boolean(context && configuration && pricing && !missingEmail && !pricingBusy)

  const create = () => {
    if (!context || !configuration || !canSubmit) return
    startTransition(async () => {
      try {
        unwrapAction(
          await createPurchaseAgreementAction({
            ...configuration,
            reservationId: context.reservationId,
            terms: terms.trim() || null,
            effectiveDate,
          }),
        )
        toast({
          title: "Agreement sent for signature",
          description: `${context.buyerName ?? "The buyer"} has it by email.`,
        })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Could not write the agreement", description: (error as Error).message })
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
          {loadError ? (
            <Notice tone="destructive" title="Cannot write an agreement yet" body={loadError} />
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
                      disabled={Boolean(context.pinnedVersionId) || context.versions.length <= 1}
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
                      placeholder={context.elevationLabel ?? "Base"}
                      options={context.elevations.map((row) => ({ value: row.id, label: row.label }))}
                    />
                  </Field>
                </div>
                {context.swing && context.swing !== "either" ? (
                  <p className="text-[11px] text-muted-foreground">
                    This lot takes a {context.swing}-swing plan.
                  </p>
                ) : null}
              </Section>

              <CatalogSection
                title="Structural options"
                hint="Chosen now because they change the build, not the finishes."
                items={context.structuralOptions}
                picks={picks}
                onToggle={togglePick}
              />

              <CatalogSection
                title="Design selections"
                hint="Anything left blank is chosen later in Design Studio, at the price sheet in force then."
                items={[...context.packages, ...context.designSelections]}
                picks={picks}
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
        </ScrollArea>

        <div className="border-t px-5 py-3">
          {priceError ? (
            <p className="flex items-start gap-2 text-[11px] text-destructive">
              <AlertTriangle className="mt-px size-3.5 shrink-0" />
              <span>{priceError}</span>
            </p>
          ) : pricing ? (
            <PriceSummary pricing={pricing} busy={pricingBusy} />
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

function PriceSummary({ pricing, busy }: { pricing: AgreementDraftPricing; busy: boolean }) {
  const options = pricing.structuralOptionsCents + pricing.designSelectionsCents
  return (
    <div className={cn("space-y-1", busy && "opacity-60")}>
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
  onToggle,
}: {
  title: string
  hint: string
  items: AgreementCatalogItem[]
  picks: Pick[]
  onToggle: (item: Pick) => void
}) {
  if (items.length === 0) {
    return (
      <Section title={title}>
        <p className="text-xs text-muted-foreground">Nothing in the catalog for this community yet.</p>
      </Section>
    )
  }
  const selectedCount = items.filter((item) =>
    picks.some((pick) => keyOf(pick) === keyOf(item)),
  ).length
  return (
    <Section title={selectedCount > 0 ? `${title} · ${selectedCount}` : title} hint={hint}>
      <div className="space-y-1">
        {items.map((item) => (
          <Row
            key={keyOf(item)}
            label={item.label}
            meta={[item.category, formatMoneyCents(item.priceCents)].filter(Boolean).join(" · ")}
            selected={picks.some((pick) => keyOf(pick) === keyOf(item))}
            onToggle={() =>
              onToggle(item.optionId ? { optionId: item.optionId } : { packageId: item.packageId })
            }
          />
        ))}
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
