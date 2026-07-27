"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import {
  archiveCatalogEntityAction,
  setCatalogPriceAction,
  upsertCategoryAction,
} from "@/app/(app)/design-studio/actions"
import type { CatalogDto, CatalogOptionDto, PlanPricingMatrix } from "@/lib/services/option-catalog"
import { swatchHue } from "@/lib/selections/swatch"
import { unwrapAction } from "@/lib/action-result"
import { StudioShell } from "@/components/design-studio/studio-shell"
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
  catalog: CatalogDto
  matrix: PlanPricingMatrix
  communityId?: string
  communities: Array<{ id: string; name: string }>
  canManage: boolean
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

export function CatalogWorkbench({ catalog, matrix, communityId, communities, canManage }: Props) {
  const router = useRouter()
  const [view, setView] = useState<View>("grid")
  const [categoryId, setCategoryId] = useState(catalog.categories[0]?.id ?? "")
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [editing, setEditing] = useState<{ option: CatalogOptionDto | null } | null>(null)
  const [pending, startTransition] = useTransition()

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

  /** Inline cell edit — repricing after a vendor increase is a bulk task. */
  function savePlanPrice(optionId: string, versionId: string, raw: string) {
    const trimmed = raw.trim()
    if (trimmed === "") return
    const dollars = Number(trimmed)
    if (!Number.isFinite(dollars) || dollars < 0) {
      toast.error("Enter a price of zero or more")
      return
    }
    startTransition(async () => {
      try {
        unwrapAction(
          await setCatalogPriceAction({
            optionId,
            housePlanVersionId: versionId,
            communityId: communityId ?? null,
            priceCents: Math.round(dollars * 100),
            isAvailable: true,
          }),
        )
        router.refresh()
      } catch (error) {
        toast.error("Could not save that price", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  const options = category?.options ?? []

  return (
    <StudioShell
      active="catalog"
      communityId={communityId}
      communities={communities}
      action={
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant={view === "grid" ? "default" : "outline"}
            className="h-8 rounded-none"
            onClick={() => setView("grid")}
          >
            Grid
          </Button>
          <Button
            size="sm"
            variant={view === "pricing" ? "default" : "outline"}
            className="h-8 rounded-none"
            onClick={() => setView("pricing")}
          >
            Pricing
          </Button>
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
                onClick={() => setCategoryId(item.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{item.name}</span>
                  <span className="block truncate text-[10.5px] text-muted-foreground">
                    {item.options.length} {item.options.length === 1 ? "option" : "options"} ·{" "}
                    {item.source === "org" ? "org" : item.source === "community_override" ? "overridden" : "community"}
                  </span>
                </span>
              </button>
            ))
          )}
        </nav>

        <section className="flex min-w-0 flex-col">
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
                                step="1"
                                disabled={!canManage || pending || option.is_default}
                                defaultValue={cell?.priceCents != null ? (cell.priceCents / 100).toFixed(0) : ""}
                                placeholder={option.is_default ? "—" : ((option.price_cents ?? 0) / 100).toFixed(0)}
                                aria-label={`${option.name} price on ${plan.planName}`}
                                className="h-7 rounded-none border-transparent bg-transparent px-2 text-right font-mono text-[12px] tabular-nums hover:border-[var(--line-strong)] focus:border-primary"
                                onBlur={(event) => {
                                  const next = event.target.value
                                  const current = cell?.priceCents != null ? (cell.priceCents / 100).toFixed(0) : ""
                                  if (next !== current) savePlanPrice(option.id, plan.versionId, next)
                                }}
                              />
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
