"use client"

import { useRouter } from "next/navigation"
import { useEffect, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { AlertTriangle, Check, Loader2, Lock } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import {
  createPurchaseAgreementAction,
  getAgreementConfiguratorDataAction,
  priceAgreementDraftAction,
} from "@/app/(app)/sales/actions"
import { unwrapAction } from "@/lib/action-result"
import { composePurchaseAgreementPricing, type PurchaseAgreementPricing } from "@/lib/financials/purchase-agreement-pricing"
import type { SellableUnitDTO } from "@/lib/services/community-sales"
import { cn } from "@/lib/utils"

import { money } from "./sales-format"

interface CatalogOption {
  id: string
  name: string
  option_scope?: string | null
  price_cents?: number | null
  is_available?: boolean | null
}
interface CatalogCategory {
  id: string
  name: string
  options: CatalogOption[]
}
interface CatalogPackage {
  id: string
  name: string
  price_cents?: number | null
}
interface ConfiguratorIncentive {
  id: string
  name: string
  incentiveType: "fixed_amount" | "percent_of_base"
  appliesTo: "price" | "design_credit"
  amountCents: number | null
  percent: number | null
}
interface ConfiguratorData {
  unit: SellableUnitDTO
  catalog: { categories: CatalogCategory[]; packages: CatalogPackage[] }
  incentives: ConfiguratorIncentive[]
  versions: { id: string; label: string }[]
  elevations: { id: string; label: string }[]
}

export function AgreementConfigurator({ lotId, onClose }: { lotId: string; onClose: () => void }) {
  const router = useRouter()
  const [data, setData] = useState<ConfiguratorData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [optionIds, setOptionIds] = useState<Set<string>>(new Set())
  const [packageIds, setPackageIds] = useState<Set<string>>(new Set())
  const [incentiveIds, setIncentiveIds] = useState<Set<string>>(new Set())
  const [versionId, setVersionId] = useState<string | undefined>(undefined)
  const [elevationId, setElevationId] = useState<string | undefined>(undefined)
  const [terms, setTerms] = useState("")
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))

  const [serverDraft, setServerDraft] = useState<PurchaseAgreementPricing | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [submitting, startSubmit] = useTransition()

  useEffect(() => {
    let active = true
    setLoading(true)
    getAgreementConfiguratorDataAction(lotId)
      .then((result) => {
        if (!active) return
        if (result.success && result.data) {
          setData(result.data as ConfiguratorData)
          if (result.data.unit.availability !== "reserved") setLoadError("reserve")
        } else {
          setLoadError(result.success ? "notfound" : result.error ?? "Failed to load")
        }
      })
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [lotId])

  const unit = data?.unit
  const isTbb = unit?.unitType === "tbb"
  const needsVersion = isTbb && !versionId

  const configuration = useMemo(
    () => ({
      lotId,
      housePlanVersionId: versionId,
      elevationId: elevationId ?? null,
      optionItems: [
        ...Array.from(optionIds).map((id) => ({ optionId: id })),
        ...Array.from(packageIds).map((id) => ({ packageId: id })),
      ],
      incentiveIds: Array.from(incentiveIds),
    }),
    [lotId, versionId, elevationId, optionIds, packageIds, incentiveIds],
  )

  // Optimistic client estimate — instant feedback before the server draft returns.
  const clientEstimate = useMemo<PurchaseAgreementPricing | null>(() => {
    if (!data || !unit) return null
    const optionById = new Map<string, CatalogOption>()
    for (const category of data.catalog.categories) for (const option of category.options) optionById.set(option.id, option)
    const packageById = new Map(data.catalog.packages.map((row) => [row.id, row]))
    const structural = Array.from(optionIds)
      .map((id) => optionById.get(id))
      .filter((option): option is CatalogOption => Boolean(option) && option!.option_scope === "structural")
      .map((option) => ({ label: option.name, priceCents: Number(option.price_cents ?? 0), source: "option" }))
    const design = [
      ...Array.from(optionIds)
        .map((id) => optionById.get(id))
        .filter((option): option is CatalogOption => Boolean(option) && option!.option_scope !== "structural")
        .map((option) => ({ label: option.name, priceCents: Number(option.price_cents ?? 0), source: "option" })),
      ...Array.from(packageIds)
        .map((id) => packageById.get(id))
        .filter((row): row is CatalogPackage => Boolean(row))
        .map((row) => ({ label: row.name, priceCents: Number(row.price_cents ?? 0), source: "package" })),
    ]
    const incentives = data.incentives
      .filter((incentive) => incentiveIds.has(incentive.id))
      .map((incentive) => ({ incentiveId: incentive.id, name: incentive.name, incentiveType: incentive.incentiveType, appliesTo: incentive.appliesTo, amountCents: incentive.amountCents, percent: incentive.percent }))
    return composePurchaseAgreementPricing({ basePriceCents: unit.basePriceCents, lotPremiumCents: unit.premiumCents, structuralOptions: structural, designSelections: design, incentives })
  }, [data, unit, optionIds, packageIds, incentiveIds])

  // Server draft (authority), debounced.
  useEffect(() => {
    if (!data || loadError || needsVersion) return
    setDrafting(true)
    setDraftError(null)
    const timer = setTimeout(async () => {
      const result = await priceAgreementDraftAction(configuration)
      if (result.success && result.data) {
        setServerDraft(result.data as PurchaseAgreementPricing)
      } else {
        setDraftError(result.success ? null : result.error ?? "Could not price this configuration")
      }
      setDrafting(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [configuration, data, loadError, needsVersion])

  const pricing = serverDraft ?? clientEstimate
  const total = pricing?.totalCents ?? 0
  const depositCents = unit?.depositRequiredCents ?? 0

  const submit = () => {
    if (!unit?.reservationId) return
    startSubmit(async () => {
      try {
        const result = unwrapAction(
          await createPurchaseAgreementAction({
            reservationId: unit.reservationId,
            ...configuration,
            terms: terms.trim() || null,
            effectiveDate,
          }),
        ) as { number?: string; signing?: { reason?: string | null } }
        if (result?.signing?.reason) {
          toast.warning("Agreement created as a draft", { description: result.signing.reason })
        } else {
          toast.success(`Agreement ${result?.number ?? ""} sent for signature`.trim())
        }
        router.refresh()
        onClose()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not create agreement")
      }
    })
  }

  const toggle = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) =>
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 rounded-none p-0 sm:max-w-3xl" side="right">
        <SheetHeader className="shrink-0 space-y-0 border-b bg-muted/30 p-5 pr-12">
          <SheetTitle className="text-base">Write purchase agreement</SheetTitle>
          {unit ? <p className="text-xs text-muted-foreground">{unit.communityName} · Lot {unit.lotLabel} · {unit.planLabel ?? "Unassigned plan"}</p> : null}
        </SheetHeader>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>
        ) : loadError === "reserve" ? (
          <Guard title="Reserve this lot first" body="A purchase agreement needs a reserved lot with a buyer and project. Convert the hold to a reservation, then write the contract." onClose={onClose} />
        ) : loadError === "notfound" || !data || !unit ? (
          <Guard title="Unit unavailable" body="This unit isn't in your scope, or was released." onClose={onClose} />
        ) : (
          <>
            <div className="flex min-h-0 flex-1">
              {/* LEFT: configuration */}
              <div className="min-w-0 flex-1 space-y-6 overflow-y-auto p-5">
                <ConfigSection label="Home">
                  {isTbb ? (
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Plan version">
                        <Select value={versionId} onValueChange={setVersionId}>
                          <SelectTrigger className="rounded-none"><SelectValue placeholder="Select released version" /></SelectTrigger>
                          <SelectContent>{data.versions.map((version) => <SelectItem key={version.id} value={version.id}>{version.label}</SelectItem>)}</SelectContent>
                        </Select>
                      </Field>
                      <Field label="Elevation">
                        <Select value={elevationId} onValueChange={setElevationId}>
                          <SelectTrigger className="rounded-none"><SelectValue placeholder="Standard" /></SelectTrigger>
                          <SelectContent>{data.elevations.map((elevation) => <SelectItem key={elevation.id} value={elevation.id}>{elevation.label}</SelectItem>)}</SelectContent>
                        </Select>
                      </Field>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Lock className="size-3.5" /> Plan, version and elevation are pinned for this spec home.
                    </div>
                  )}
                  {data.versions.length === 0 && isTbb ? (
                    <p className="text-[11px] text-[var(--age-2)]">No released plan version is available for this community.</p>
                  ) : null}
                </ConfigSection>

                <ConfigSection label="Structural options">
                  <OptionList
                    options={data.catalog.categories.flatMap((category) => category.options.filter((option) => option.option_scope === "structural"))}
                    selected={optionIds}
                    onToggle={(id) => toggle(setOptionIds, id)}
                    emptyText="No structural options in this catalog."
                  />
                </ConfigSection>

                <ConfigSection label="Design selections">
                  <OptionList
                    options={data.catalog.categories.flatMap((category) => category.options.filter((option) => option.option_scope !== "structural"))}
                    packages={data.catalog.packages}
                    selectedPackages={packageIds}
                    selected={optionIds}
                    onToggle={(id) => toggle(setOptionIds, id)}
                    onTogglePackage={(id) => toggle(setPackageIds, id)}
                    emptyText="No design options in this catalog."
                  />
                </ConfigSection>

                <ConfigSection label="Incentives">
                  {data.incentives.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No active incentives in this community.</p>
                  ) : (
                    <div className="space-y-1">
                      {data.incentives.map((incentive) => (
                        <Row key={incentive.id} label={incentive.name} note={incentive.appliesTo === "design_credit" ? "Design credit" : incentive.incentiveType === "percent_of_base" ? `${incentive.percent}% of base` : undefined} checked={incentiveIds.has(incentive.id)} onToggle={() => toggle(setIncentiveIds, incentive.id)} valueCents={pricing?.incentives.find((row) => row.incentiveId === incentive.id)?.valueCents} negative />
                      ))}
                    </div>
                  )}
                </ConfigSection>

                <ConfigSection label="Terms">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Effective date"><Input type="date" value={effectiveDate} onChange={(event) => setEffectiveDate(event.target.value)} className="rounded-none" /></Field>
                  </div>
                  <Field label="Contract terms (optional)"><Textarea rows={3} value={terms} onChange={(event) => setTerms(event.target.value)} className="rounded-none" placeholder="Financing, contingencies, special provisions…" /></Field>
                </ConfigSection>
              </div>

              {/* RIGHT: running total */}
              <div className="hidden w-[300px] shrink-0 flex-col border-l p-5 sm:flex">
                <p className="microlabel">Contract price</p>
                <div className="mt-1 flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-semibold tabular-nums">{money.format(total / 100)}</span>
                  {drafting ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                </div>
                <div className="mt-4 space-y-1.5 text-xs">
                  <Summary label="Base price" value={pricing?.basePriceCents ?? 0} />
                  {pricing && pricing.lotPremiumCents > 0 ? <Summary label="Lot premium" value={pricing.lotPremiumCents} /> : null}
                  {pricing && pricing.structuralOptionsCents > 0 ? <Summary label="Structural options" value={pricing.structuralOptionsCents} /> : null}
                  {pricing && pricing.designSelectionsCents > 0 ? <Summary label="Design selections" value={pricing.designSelectionsCents} /> : null}
                  {pricing && pricing.incentivesCents > 0 ? <Summary label="Incentives" value={-pricing.incentivesCents} tone="down" /> : null}
                  <div className="flex items-center justify-between border-t pt-1.5 font-medium">
                    <span>Total</span>
                    <span className="font-mono tabular-nums">{money.format(total / 100)}</span>
                  </div>
                  {depositCents > 0 ? (
                    <>
                      <Summary label="Deposit received" value={-depositCents} tone="down" />
                      <div className="flex items-center justify-between font-medium">
                        <span>Balance at closing</span>
                        <span className="font-mono tabular-nums">{money.format((total - depositCents) / 100)}</span>
                      </div>
                    </>
                  ) : null}
                </div>
                {draftError ? (
                  <p className="mt-3 flex items-start gap-1.5 text-[11px] text-[var(--age-2)]"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{draftError}</p>
                ) : (
                  <p className="mt-3 text-[11px] text-muted-foreground">Signing sends to the buyer{unit.buyerName ? "" : "(s)"}, then the builder.</p>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t p-4">
              <span className="text-xs text-muted-foreground">{needsVersion ? "Choose a plan version to price" : draftError ? "Fix the configuration to continue" : "Ready to send"}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" className="rounded-none" onClick={onClose} disabled={submitting}>Cancel</Button>
                <Button className="rounded-none" onClick={submit} disabled={submitting || Boolean(draftError) || needsVersion || total <= 0}>
                  {submitting ? <Loader2 className="mr-1 size-3.5 animate-spin" /> : <Check className="mr-1 size-3.5" />} Create &amp; send for signature
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function ConfigSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <p className="microlabel">{label}</p>
      {children}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function OptionList({
  options,
  packages,
  selected,
  selectedPackages,
  onToggle,
  onTogglePackage,
  emptyText,
}: {
  options: CatalogOption[]
  packages?: CatalogPackage[]
  selected: Set<string>
  selectedPackages?: Set<string>
  onToggle: (id: string) => void
  onTogglePackage?: (id: string) => void
  emptyText: string
}) {
  if (options.length === 0 && (!packages || packages.length === 0)) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>
  }
  return (
    <div className="space-y-1">
      {(packages ?? []).map((row) => (
        <Row key={row.id} label={row.name} note="Package" checked={selectedPackages?.has(row.id) ?? false} onToggle={() => onTogglePackage?.(row.id)} valueCents={Number(row.price_cents ?? 0)} />
      ))}
      {options.map((option) => (
        <Row key={option.id} label={option.name} checked={selected.has(option.id)} onToggle={() => onToggle(option.id)} valueCents={Number(option.price_cents ?? 0)} disabled={option.is_available === false} />
      ))}
    </div>
  )
}

function Row({
  label,
  note,
  checked,
  onToggle,
  valueCents,
  negative,
  disabled,
}: {
  label: string
  note?: string
  checked: boolean
  onToggle: () => void
  valueCents?: number
  negative?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn("flex w-full items-center justify-between gap-3 border px-3 py-2 text-left text-xs", checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/50", disabled && "cursor-not-allowed opacity-50")}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className={cn("flex size-4 shrink-0 items-center justify-center border", checked ? "border-primary bg-primary text-primary-foreground" : "border-input")}>{checked ? <Check className="size-3" /> : null}</span>
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          {note ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{note}</span> : null}
        </span>
      </span>
      {valueCents != null && valueCents !== 0 ? (
        <span className={cn("font-mono tabular-nums", negative && "text-[var(--age-2)]")}>{negative ? "−" : "+"}{money.format(Math.abs(valueCents) / 100)}</span>
      ) : null}
    </button>
  )
}

function Summary({ label, value, tone }: { label: string; value: number; tone?: "down" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-mono tabular-nums", tone === "down" && "text-[var(--age-2)]")}>{value < 0 ? "−" : ""}{money.format(Math.abs(value) / 100)}</span>
    </div>
  )
}

function Guard({ title, body, onClose }: { title: string; body: string; onClose: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
      <Button variant="outline" className="mt-2 rounded-none" onClick={onClose}>Close</Button>
    </div>
  )
}
