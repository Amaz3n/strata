"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import {
  archiveCatalogEntityAction,
  setCatalogPriceAction,
  publishCatalogPricesAction,
  upsertCategoryAction,
} from "@/app/(app)/design-studio/actions"
import type { z } from "zod"
import type { catalogPricePublicationSchema } from "@/lib/validation/selections"
import type { CatalogDto, CatalogOptionDto, PlanPricingMatrix } from "@/lib/services/option-catalog"
import { swatchHue } from "@/lib/selections/swatch"
import { clearPricePublication, persistPricePublication, pricePublicationLockName, readPricePublication } from "@/lib/selections/price-publication-recovery"
import { unwrapAction } from "@/lib/action-result"
import { StudioShell } from "@/components/design-studio/studio-shell"
import { CatalogPublicationReconciliation } from "@/components/design-studio/catalog-publication-reconciliation"
import { OptionDialog } from "@/components/design-studio/option-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Archive, Edit, Plus } from "@/components/icons"

import "./studio.css"

type View = "grid" | "pricing"

interface Props {
  orgId: string
  actorId: string
  initialCategoryId?: string
  initialView?: View
  categoryOptionCounts?: Record<string,number>
  catalog: CatalogDto
  matrix: PlanPricingMatrix
  communityId?: string
  canManage: boolean
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(cents / 100)
}

export function CatalogWorkbench({ catalog, matrix, communityId, canManage, orgId, actorId, initialCategoryId, initialView, categoryOptionCounts }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [view, setView] = useState<View>(initialView ?? "grid")
  const [categoryId] = useState(initialCategoryId ?? catalog.categories[0]?.id ?? "")
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [editing, setEditing] = useState<{ option: CatalogOptionDto | null } | null>(null)
  const [pending, startTransition] = useTransition()
  type PriceItem = z.infer<typeof catalogPricePublicationSchema>["items"][number]
  type PriceAttempt = z.infer<typeof catalogPricePublicationSchema>
  const priceDrafts = useRef<Record<string, PriceItem>>({})
  const publicationKey = useRef<string | null>(null)
  const publicationAttempt = useRef<PriceAttempt | null>(null)
  const publicationBusy = useRef(false)
  const invalidPriceKeys = useRef(new Set<string>())
  const [drafts, setDrafts] = useState<Record<string, PriceItem>>({})
  const [texts, setTexts] = useState<Record<string, string>>({})
  const [invalidPrices, setInvalidPrices] = useState<Record<string, string>>({})
  const [priceRecovery, setPriceRecovery] = useState<PriceAttempt | null>(null)
  const [priceError, setPriceError] = useState<string | null>(null)
  const recoveryChecked = useRef(false)
  const [recoveryReady, setRecoveryReady] = useState(false)
  const scope = useMemo(() => ({ orgId, actorId, communityId }), [orgId, actorId, communityId])
  useEffect(() => {
    try {
      const attempt = readPricePublication(window.localStorage, scope)
      if (attempt) {
        publicationAttempt.current = attempt
        publicationKey.current = attempt.publicationKey
        setPriceRecovery(attempt)
        setView("pricing")
      }
      recoveryChecked.current = true
      setRecoveryReady(true)
    } catch {
      setPriceError("Saved price publication could not be read. Restore browser storage and reload to reconcile it before publishing again.")
    }
  }, [scope])
  const navigationBlocked = pending || (matrix.atomicPricing && !recoveryReady) || Boolean(priceRecovery) || Object.keys(drafts).length > 0 || Object.keys(invalidPrices).length > 0
  function changeWindow(values: Record<string,string>) {
    if (navigationBlocked || publicationBusy.current || publicationAttempt.current || Object.keys(priceDrafts.current).length || invalidPriceKeys.current.size) return
    const params = new URLSearchParams(searchParams.toString())
    for (const [key,value] of Object.entries(values)) params.set(key,value)
    params.set("view",view)
    startTransition(() => router.replace(`${pathname}?${params.toString()}`))
  }

  const category = useMemo(
    () => catalog.categories.find((item) => item.id === categoryId) ?? catalog.categories[0] ?? null,
    [catalog.categories, categoryId],
  )

  function createCategory(formData: FormData) {
    startTransition(async () => {
      try {
        unwrapAction(
          await upsertCategoryAction({
            communityId: communityId ?? null,
            name: String(formData.get("name") ?? ""),
            description: String(formData.get("description") ?? "") || null,
            sortOrder: catalog.categories.length,
          }),
        )
        setCategoryOpen(false)
        toast.success("Category added")
        router.refresh()
      } catch (error) {
        toast.error("Could not add the category", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  function archiveOption(option: CatalogOptionDto) {
    startTransition(async () => {
      try {
        unwrapAction(await archiveCatalogEntityAction({ type: "option", id: option.id, archived: true }))
        toast.success(`${option.name} archived`)
        router.refresh()
      } catch (error) {
        toast.error("Could not archive the option", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  /** Edits are reviewed together; uncertain retries retain the exact batch. */
  function savePlanPrice(optionId: string, versionId: string, raw: string) {
    if ((matrix.atomicPricing && !recoveryChecked.current) || publicationBusy.current || publicationAttempt.current || priceRecovery) return
    const key = `${optionId}:${versionId}`, trimmed = raw.trim()
    if (trimmed === "") {
      invalidPriceKeys.current.delete(key)
      delete priceDrafts.current[key]
      setDrafts({ ...priceDrafts.current })
      setInvalidPrices(current => { const next={...current};delete next[key];return next })
      return
    }
    const cents = Math.round(Number(trimmed) * 100)
    if (!/^\d+(?:\.\d{0,2})?$/.test(trimmed) || !Number.isSafeInteger(cents) || cents>2147483647) {
      invalidPriceKeys.current.add(key)
      setInvalidPrices(current => ({ ...current, [key]: "Enter a supported price with at most two decimal places" }))
      return
    }
    invalidPriceKeys.current.delete(key)
    setInvalidPrices(current => { const next={...current};delete next[key];return next })
    const cell = matrix.cells[key]
    if (cell?.priceCents === cents) {
      delete priceDrafts.current[key];setDrafts({ ...priceDrafts.current });return
    }
    const item: PriceItem = { optionId, housePlanVersionId: versionId, priceCents: cents, isAvailable: cell?.isAvailable ?? true, expectedPrice: cell?.ownPrice ?? null }
    if (matrix.atomicPricing) {
      publicationKey.current ??= crypto.randomUUID()
      priceDrafts.current[key] = item
      setDrafts({ ...priceDrafts.current })
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(await setCatalogPriceAction({ ...item, communityId: communityId ?? null, expectedOrgId: orgId, expectedActorId: actorId }))
        router.refresh()
      } catch (error) { toast.error("Could not save that price", { description: error instanceof Error ? error.message : undefined }) }
    })
  }

  function publishPrices() {
    if (!canManage || !recoveryChecked.current || publicationBusy.current || invalidPriceKeys.current.size>0 || !matrix.atomicPricing) return
    const items = Object.values(priceDrafts.current)
    const recovering = publicationAttempt.current !== null
    const attempt = publicationAttempt.current ?? (publicationKey.current && items.length ? { publicationKey: publicationKey.current, expectedOrgId: orgId, expectedActorId: actorId, communityId: communityId ?? null, items } : null)
    if (!attempt) return
    if (!navigator.locks) {
      setPriceError("This browser cannot protect publication across tabs. Use a browser with Web Locks support to publish prices.")
      return
    }
    publicationBusy.current = true
    setPriceError(null)
    startTransition(async () => {
      try {
        await navigator.locks.request(pricePublicationLockName(scope), async () => {
          persistPricePublication(window.localStorage, scope, attempt)
          publicationAttempt.current = attempt
          const result = await publishCatalogPricesAction(attempt)
          if (!recovering && !result.success && result.code!=="CATALOG_PUBLICATION_UNCONFIRMED") {
            clearPricePublication(window.localStorage, scope, attempt)
            publicationAttempt.current = null
            setPriceRecovery(null)
          }
          unwrapAction(result)
          clearPricePublication(window.localStorage, scope, attempt)
          publicationAttempt.current = null;publicationKey.current=null;priceDrafts.current={}
          setDrafts({});setTexts({});setPriceRecovery(null)
          toast.success(`${attempt.items.length} prices published`)
          router.refresh()
        })
      } catch (error) {
        if (publicationAttempt.current) setPriceRecovery(attempt)
        setPriceError(error instanceof Error ? error.message : "Could not confirm price publication")
      } finally { publicationBusy.current=false }
    })
  }

  function discardPrices() {
    if (publicationBusy.current || publicationAttempt.current || priceRecovery) return
    priceDrafts.current={};publicationAttempt.current=null;publicationKey.current=null;invalidPriceKeys.current.clear()
    setDrafts({});setTexts({});setInvalidPrices({});setPriceError(null)
    router.refresh()
  }

  const options = (category?.options ?? []).filter(option => matrix.optionIds.includes(option.id))

  return (
    <StudioShell
      active="catalog"
      action={
        // A view toggle, not a primary action — it borrows the tab vocabulary
        // rather than the brand colour, which belongs to things that mutate.
        <div className="flex items-center border border-border" role="group" aria-label="Catalog view">
          {(["grid", "pricing"] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={view === key}
              disabled={navigationBlocked}
              onClick={() => setView(key)}
              className={`px-3 py-1 text-[12.5px] capitalize transition-colors ${
                view === key ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {key}
            </button>
          ))}
        </div>
      }
    >
      <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav
          className="flex flex-col border-b lg:border-b-0 lg:border-r border-border"
          aria-label="Option categories"
        >
          <div
            className="flex items-center justify-between border-b px-3.5 py-2 border-border bg-muted"
          >
            <span className="microlabel">Categories</span>
            {canManage && (
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 rounded-none"
                onClick={() => setCategoryOpen(true)}
                aria-label="Add category"
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          {catalog.categories.length === 0 ? (
            <p className="p-4 text-[13px] text-muted-foreground">
              No categories yet.
            </p>
          ) : (
            catalog.categories.map((item) => (
              <button
                key={item.id}
                type="button"
                className="studio-cat"
                data-selected={item.id === category?.id}
                aria-label={item.name}
                aria-current={item.id === category?.id ? "true" : undefined}
                disabled={navigationBlocked}
                onClick={() => changeWindow({ category: item.id, planPage: "1", optionPage: "1" })}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{item.name}</span>
                  <span className="block truncate text-[10.5px] text-muted-foreground">
                    {categoryOptionCounts?.[item.id] ?? item.options.length} {item.options.length === 1 ? "option" : "options"} ·{" "}
                    {item.source === "org" ? "org" : item.source === "community_override" ? "overridden" : "community"}
                  </span>
                </span>
              </button>
            ))
          )}
        </nav>

        <section className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs">
            <span>Options page {matrix.optionPage}{view === "pricing" ? ` · Plans page ${matrix.planPage}` : ""}</span>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={navigationBlocked || matrix.optionPage<=1} onClick={() => changeWindow({ optionPage: String(matrix.optionPage-1) })}>Previous options</Button>
              <Button size="sm" variant="outline" disabled={navigationBlocked || !matrix.hasMoreOptions} onClick={() => changeWindow({ optionPage: String(matrix.optionPage+1) })}>Next options</Button>
              {view === "pricing" && <>
                <Button size="sm" variant="outline" aria-pressed={matrix.includeOlderVersions} disabled={navigationBlocked} onClick={() => changeWindow({ releases: matrix.includeOlderVersions ? "latest" : "all", planPage: "1" })}>{matrix.includeOlderVersions ? "Show latest releases" : "Show older releases"}</Button>
                <Button size="sm" variant="outline" disabled={navigationBlocked || matrix.planPage<=1} onClick={() => changeWindow({ planPage: String(matrix.planPage-1) })}>Previous plans</Button>
                <Button size="sm" variant="outline" disabled={navigationBlocked || !matrix.hasMorePlans} onClick={() => changeWindow({ planPage: String(matrix.planPage+1) })}>Next plans</Button>
              </>}
            </div>
          </div>
          {view === "pricing" && (matrix.atomicPricing || priceRecovery || priceError) && (canManage || priceRecovery || priceError) && <div className="flex flex-wrap items-center gap-3 border-b px-3 py-2">
            <span className="text-sm">{Object.keys(drafts).length} price edits ready to publish</span>
            <Button size="sm" disabled={!canManage || !matrix.atomicPricing || !recoveryReady || pending || (!priceRecovery && Object.keys(drafts).length===0) || Object.keys(invalidPrices).length>0} onClick={publishPrices}>{priceRecovery ? "Retry reviewed batch" : "Publish prices"}</Button>
            <Button size="sm" variant="outline" disabled={pending || Boolean(priceRecovery)} onClick={discardPrices}>Discard edits and reload</Button>
            {Object.keys(invalidPrices).length>0 && <p role="alert" className="text-sm text-destructive">Correct the highlighted prices before publishing.</p>}
            {priceRecovery && !canManage && <p role="alert" className="text-sm">Your catalog management access has changed. The saved batch is retained for reconciliation.</p>}
            {priceRecovery && !matrix.atomicPricing && <p role="alert" className="text-sm">Price publication is currently unavailable. The reviewed batch is retained until publication is enabled again.</p>}
            {priceRecovery && <p role="alert" className="text-sm">Publication is unconfirmed. Retry the same {priceRecovery.items.length} prices to recover the save.</p>}
            {priceError && <p role="alert" className="text-sm text-destructive">{priceError}</p>}
            {priceRecovery && <CatalogPublicationReconciliation key={priceRecovery.publicationKey} publication={{ kind: "prices", attempt: priceRecovery }} disabled={!canManage || !matrix.atomicPricing || pending} onReconciled={() => {
              publicationAttempt.current=null;publicationKey.current=null;priceDrafts.current={};invalidPriceKeys.current.clear()
              setDrafts({});setTexts({});setInvalidPrices({});setPriceRecovery(null);setPriceError(null);router.refresh()
            }} />}
          </div>}
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 border-border"
          >
            <h2 className="text-[14px] font-semibold tracking-tight">{category?.name ?? "Options"}</h2>
            {canManage && category && (
              <Button size="sm" className="h-7 rounded-none" onClick={() => setEditing({ option: null })}>
                <Plus className="mr-1 h-3.5 w-3.5" />
                Option
              </Button>
            )}
          </div>

          {!category || options.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
              <p className="text-sm font-medium">
                {category ? `No options in ${category.name}` : "Build the option catalog"}
              </p>
              <p className="max-w-md text-[13px] text-muted-foreground">
                Start with the grade included in base price, then add the upgrades a buyer can pay for.
              </p>
              {canManage && category && (
                <Button size="sm" variant="outline" className="mt-2 h-8 rounded-none" onClick={() => setEditing({ option: null })}>
                  Add the standard grade
                </Button>
              )}
            </div>
          ) : view === "grid" ? (
            <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(178px,1fr))]">
              {options.map((option) => (
                <div key={option.id} className="studio-option">
                  <span
                    className="studio-swatch"
                    data-generated={!option.image_url}
                    style={
                      {
                        backgroundImage: option.image_url ? `url(${option.image_url})` : undefined,
                        "--studio-swatch-hue": swatchHue(option.id),
                      } as React.CSSProperties
                    }
                  >
                    {option.is_default && <span className="studio-tag">standard</span>}
                    {!option.is_available && <span className="studio-tag">retired</span>}
                  </span>
                  <div className="flex flex-col gap-1 border-t p-2.5 border-border">
                    <span className="text-[12.5px] font-medium">{option.name}</span>
                    <span className="font-mono tabular-nums text-[12.5px]">
                      {option.is_default ? "Included" : money(option.price_cents)}
                      {catalog.can_read_margin && option.cost_cents != null && (
                        <span className="text-muted-foreground"> · cost {money(option.cost_cents)}</span>
                      )}
                    </span>
                    <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
                      {[option.sku, option.vendor, option.lead_time_days ? `${option.lead_time_days}d` : null]
                        .filter(Boolean)
                        .join(" · ") || "No sourcing details"}
                    </span>
                    {canManage && (
                      <div className="flex gap-1 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 flex-1 rounded-none px-2 text-[11px]"
                          onClick={() => setEditing({ option })}
                        >
                          <Edit className="mr-1 h-3 w-3" />
                          Edit
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6 rounded-none"
                          disabled={pending}
                          onClick={() => archiveOption(option)}
                          aria-label={`Archive ${option.name}`}
                        >
                          <Archive className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : matrix.plans.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
              <p className="text-sm font-medium">No released plan versions</p>
              <p className="max-w-md text-[13px] text-muted-foreground">
                Plan pricing needs at least one released plan version to price against.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead>
                  <tr>
                    <th className="microlabel border-b px-3 py-2.5 text-left border-[var(--line-strong)]">
                      Option
                    </th>
                    <th className="microlabel border-b px-3 py-2.5 text-left border-[var(--line-strong)]">
                      Grade
                    </th>
                    <th className="microlabel whitespace-nowrap border-b px-3 py-2.5 text-right border-[var(--line-strong)]">
                      Base
                    </th>
                    {matrix.plans.map((plan) => (
                      <th
                        key={plan.versionId}
                        className="microlabel whitespace-nowrap border-b px-3 py-2.5 text-right border-[var(--line-strong)]"
                      >
                        {plan.planName}
                        <span className="block text-[11px] font-normal">{plan.versionLabel}</span>
                      </th>
                    ))}
                    {catalog.can_read_margin && (
                      <th className="microlabel border-b px-3 py-2.5 text-right border-[var(--line-strong)]">
                        Margin
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {options.map((option) => {
                    const margin =
                      option.price_cents && option.cost_cents != null && option.price_cents > 0
                        ? Math.round(((option.price_cents - option.cost_cents) / option.price_cents) * 100)
                        : null
                    return (
                      <tr key={option.id}>
                        <td className="border-b px-3 py-2 border-border">
                          <span className="flex items-center gap-2">
                            <span
                              className="h-[18px] w-[18px] flex-none border bg-cover bg-center"
                              style={{
                                backgroundColor: swatchHue(option.id),
                                backgroundImage: option.image_url ? `url(${option.image_url})` : undefined,
                                borderColor: "var(--line-strong)",
                              }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0">{option.name}</span>
                          </span>
                        </td>
                        <td className="border-b px-3 py-2 border-border">
                          <span className="studio-pill" data-tone={option.is_default ? "standard" : undefined}>
                            {option.is_default ? "standard" : "upgrade"}
                          </span>
                        </td>
                        <td
                          className="border-b border-border px-3 py-2 text-right font-mono tabular-nums text-muted-foreground"
                        >
                          {option.is_default ? "Included" : money(option.price_cents)}
                        </td>
                        {matrix.plans.map((plan) => {
                          const cell = matrix.cells[`${option.id}:${plan.versionId}`]
                          return (
                            <td
                              key={plan.versionId}
                              className="border-b px-1.5 py-1 border-border"
                            >
                              <Input
                                type="number"
                                min="0"
                                step="0.01"
                                disabled={!canManage || (matrix.atomicPricing && !recoveryReady) || pending || Boolean(priceRecovery) || option.is_default}
                                value={texts[`${option.id}:${plan.versionId}`] ?? (cell?.priceCents != null ? (cell.priceCents / 100).toFixed(2) : "")}
                                aria-invalid={Boolean(invalidPrices[`${option.id}:${plan.versionId}`])}
                                title={invalidPrices[`${option.id}:${plan.versionId}`]}
                                onChange={event => { const value=event.target.value;setTexts(current => ({ ...current, [`${option.id}:${plan.versionId}`]: value })) }}
                                placeholder={option.is_default ? "—" : ((option.price_cents ?? 0) / 100).toFixed(2)}
                                aria-label={`${option.name} price on ${plan.planName}`}
                                className="h-7 rounded-none border-transparent bg-transparent px-2 text-right font-mono text-[12px] tabular-nums hover:border-[var(--line-strong)] focus:border-primary"
                                onBlur={(event) => {
                                  savePlanPrice(option.id, plan.versionId, event.target.value)
                                }}
                              />
                              {drafts[`${option.id}:${plan.versionId}`] && <span className="block px-2 text-right text-[11px] text-muted-foreground">{money(drafts[`${option.id}:${plan.versionId}`].expectedPrice?.price_cents ?? cell?.priceCents ?? option.price_cents)} → {money(drafts[`${option.id}:${plan.versionId}`].priceCents)}</span>}
                            </td>
                          )
                        })}
                        {catalog.can_read_margin && (
                          <td
                            className={`border-b border-border px-3 py-2 text-right font-mono tabular-nums${margin != null && margin < 20 ? " text-destructive" : ""}`}
                          >
                            {margin == null ? "—" : `${margin}%`}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="px-3 py-3 text-[11.5px] text-muted-foreground">
                Plan prices are whole dollars. A blank cell inherits the base price — type a number to override it for
                that plan.
              </p>
            </div>
          )}
        </section>
      </div>

      {category && (
        <OptionDialog
          open={Boolean(editing)}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          categoryId={category.id}
          categoryName={category.name}
          communityId={communityId}
          option={editing?.option ?? null}
          sortOrder={options.length}
          canReadMargin={catalog.can_read_margin}
          onSaved={() => router.refresh()}
        />
      )}

      <Dialog open={categoryOpen} onOpenChange={setCategoryOpen}>
        <DialogContent className="rounded-none">
          <form action={createCategory}>
            <DialogHeader>
              <DialogTitle>Add a category</DialogTitle>
              <DialogDescription>
                A category is one decision the buyer makes — flooring, countertops, cabinetry.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="category-name">Name</Label>
                <Input id="category-name" name="name" required className="rounded-none" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="category-description">Description</Label>
                <Input id="category-description" name="description" className="rounded-none" />
              </div>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={pending} className="rounded-none">
                Add category
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </StudioShell>
  )
}
