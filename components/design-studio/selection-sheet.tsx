"use client"

import { useMemo, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { applyPackageAction, chooseOptionAction } from "@/app/(app)/design-studio/actions"
import type { SelectionSheet, SheetCategory, SheetGroup, SheetOption } from "@/lib/services/design-studio"
import { swatchHue } from "@/lib/selections/swatch"
import { unwrapAction, type ActionFailure } from "@/lib/action-result"
import { SelectionApprovalPanel } from "@/components/selections/selection-approval-panel"
import { formatWarrantyVisitWindow } from "@/lib/services/warranty/visit-time"
import { PostCutoffChangeDialog } from "@/components/design-studio/post-cutoff-change-dialog"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { ArrowLeft, Calendar, Check, Lock } from "@/components/icons"

import "./studio.css"

interface Props {
  sheet: SelectionSheet
}

function money(cents: number | null | undefined) {
  if (cents == null) return "—"
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100)
}

function priceLabel(option: SheetOption) {
  if (option.isStandard || option.priceCents === 0) return "Included"
  return `+${money(option.priceCents)}`
}

function formatDay(value: string | null) {
  if (!value) return "unresolved"
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

/** A choice the home cannot have as asked, held with what it can have instead. */
type UnavailableChoice = {
  categoryId: string
  selectionId: string
  optionId: string
  message: string
  code: string | null
  supply: NonNullable<ActionFailure["supply"]>
}

function findActiveCategory(groups: SheetGroup[], categoryId: string) {
  for (const group of groups) {
    const category = group.categories.find((candidate) => candidate.id === categoryId)
    if (category) return { activeCategory: category, activeGroup: group }
  }
  return { activeCategory: groups[0]?.categories[0] ?? null, activeGroup: groups[0] ?? null }
}

export function SelectionSheetClient({ sheet }: Props) {
  const { groups } = sheet
  const router = useRouter()
  const [buyerView, setBuyerView] = useState(true)
  const [pending, startTransition] = useTransition()
  const [activeCategoryId, setActiveCategoryId] = useState(() =>
    groups.flatMap((group) => group.categories).find((category) => !category.selectedOptionId)?.id ??
      groups[0]?.categories[0]?.id ??
      "",
  )
  const [changing, setChanging] = useState<{ group: SheetGroup; initial: { selectionId: string; optionId: string } | null } | null>(null)
  const [unavailable, setUnavailable] = useState<UnavailableChoice | null>(null)

  const showInternals = sheet.canReadMargin && !buyerView

  const { activeCategory, activeGroup } = useMemo(
    () => findActiveCategory(groups, activeCategoryId),
    [groups, activeCategoryId],
  )

  const nextCutoff = useMemo(
    () => groups.find((group) => group.status === "open" && group.daysToCutoff !== null) ?? null,
    [groups],
  )

  function choose(category: SheetCategory, optionId: string) {
    if (!sheet.canManage) return
    setUnavailable(null)
    startTransition(async () => {
      const result = await chooseOptionAction({
        projectId: sheet.home.projectId,
        selectionId: category.selectionId,
        optionId,
      })
      if (result.success) {
        router.refresh()
        return
      }
      if (result.supply) {
        setUnavailable({
          categoryId: category.id,
          selectionId: category.selectionId,
          optionId,
          message: result.error,
          code: result.code ?? null,
          supply: result.supply,
        })
        // The refusal opened an exception on the home; the workbench band lists it.
        router.refresh()
        return
      }
      toast.error("Could not record that choice", { description: result.error })
    })
  }

  function applyPackage(packageId: string, name: string) {
    startTransition(async () => {
      try {
        unwrapAction(await applyPackageAction({ projectId: sheet.home.projectId, packageId }))
        toast.success(`${name} applied`)
        router.refresh()
      } catch (error) {
        toast.error("Could not apply the package", {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    })
  }

  return (
    <div className="studio flex min-h-0 flex-1 flex-col">
      <header
        className="flex flex-wrap items-center justify-between gap-4 border-b px-5 py-3 border-border bg-muted/40"
      >
        <div className="flex items-center gap-3">
          <Button asChild size="icon" variant="ghost" className="h-8 w-8 rounded-none">
            <Link href="/design-studio" aria-label="Back to the runway">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <p className="text-base font-semibold tracking-tight">{sheet.home.buyerName}</p>
            <p className="font-mono tabular-nums text-[11px] uppercase tracking-wide text-muted-foreground">
              {[sheet.home.lotLabel, sheet.home.communityName, sheet.home.planName].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Calendar className="h-3.5 w-3.5" />
            {sheet.appointment && sheet.appointment.timeZone
              ? `${formatWarrantyVisitWindow(sheet.appointment.scheduledAt, sheet.appointment.endsAt, sheet.appointment.timeZone)}${sheet.appointment.locationName ? ` · ${sheet.appointment.locationName}` : ""}`
              : "No session booked"}
          </span>
          {sheet.canReadMargin && (
            <div className="flex items-center gap-2">
              <Switch id="buyer-view" checked={buyerView} onCheckedChange={setBuyerView} />
              <Label htmlFor="buyer-view" className="text-[12.5px]">
                Buyer view
              </Label>
            </div>
          )}
          {nextCutoff && (
            <div
              className="flex items-baseline gap-2 px-3 py-1.5"
              style={{
                background: nextCutoff.state === "overdue" ? "var(--studio-late-bg)" : "var(--studio-soon-bg)",
                color: nextCutoff.state === "overdue" ? "var(--studio-late)" : "var(--studio-soon)",
              }}
            >
              <span className="font-mono tabular-nums text-lg leading-none tracking-tight">
                {Math.abs(nextCutoff.daysToCutoff ?? 0)}
              </span>
              <span className="text-[11px]">
                days {(nextCutoff.daysToCutoff ?? 0) < 0 ? "past" : "to"} {nextCutoff.name.toLowerCase()} cutoff
              </span>
            </div>
          )}
        </div>
      </header>

      {sheet.groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-6 py-24 text-center">
          <p className="text-sm font-medium">This home has no selection groups yet</p>
          <p className="max-w-md text-[13px] text-muted-foreground">
            Groups are created from the community&apos;s cutoff rules when the home is sold and scheduled.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-2 h-8 rounded-none">
            <Link href="/design-studio/rules">Review cutoff rules</Link>
          </Button>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[212px_minmax(0,1fr)_280px]">
          <nav
            className="flex flex-col overflow-y-auto border-b lg:border-b-0 lg:border-r border-border"
            aria-label="Selection categories"
          >
            {sheet.groups.map((group) => (
              <div key={group.groupId}>
                <div
                  className="flex items-center justify-between gap-2 border-b px-3.5 py-2 border-border bg-muted"
                >
                  <span className="microlabel">{group.name}</span>
                  <span className="studio-pill" data-tone={group.status === "locked" ? undefined : group.state === "overdue" ? "late" : group.state === "due_soon" ? "soon" : undefined}>
                    {group.status === "locked" ? "locked" : formatDay(group.cutoffDate)}
                  </span>
                </div>
                {group.categories.map((category) => (
                  <button
                    key={category.id}
                    type="button"
                    className="studio-cat"
                    data-selected={category.id === activeCategoryId}
                    aria-label={category.name}
                    aria-current={category.id === activeCategoryId ? "true" : undefined}
                    onClick={() => setActiveCategoryId(category.id)}
                  >
                    <span
                      className="studio-dot"
                      data-state={category.selectedOptionId ? "chosen" : group.status === "locked" ? undefined : "open"}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium">{category.name}</span>
                      <span className="studio-land block truncate text-[10.5px] text-muted-foreground">
                        {category.options.find((option) => option.id === category.selectedOptionId)?.name ?? "Not chosen"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <section className="flex min-w-0 flex-col gap-4 overflow-y-auto p-4">
            {activeGroup && activeGroup.packages.length > 0 && activeGroup.status === "open" && (
              <div className="flex flex-col gap-2">
                <p className="microlabel">Packages</p>
                {activeGroup.packages.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-3 border border-primary bg-muted/40 p-3"
                  >
                    <span className="flex flex-none gap-0.5">
                      {item.optionIds.slice(0, 3).map((optionId) => (
                        <span
                          key={optionId}
                          className="block h-7 w-4"
                          style={{ background: swatchHue(optionId) }}
                          aria-hidden="true"
                        />
                      ))}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold">{item.name}</span>
                      <span className="block text-[11.5px] text-muted-foreground">
                        Covers {item.categoryCount} {item.categoryCount === 1 ? "category" : "categories"}
                      </span>
                    </span>
                    <span className="font-mono tabular-nums flex-none text-[13px]">+{money(item.priceCents)}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 flex-none rounded-none"
                      disabled={pending || !sheet.canManage}
                      onClick={() => applyPackage(item.id, item.name)}
                    >
                      Apply
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {activeCategory && (
              <div className="flex flex-col gap-3">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 className="text-[15px] font-semibold tracking-tight">{activeCategory.name}</h2>
                  {activeCategory.description && (
                    <p className="text-[12px] text-muted-foreground">
                      {activeCategory.description}
                    </p>
                  )}
                </div>
                {unavailable?.categoryId === activeCategory.id && (
                  <div role="alert" className="flex flex-col gap-2 border border-warning/40 bg-warning/10 p-3">
                    <p className="text-[12.5px] font-medium">{unavailable.supply.reason}</p>
                    {unavailable.supply.alternates.length > 0 ? (
                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11.5px] text-muted-foreground">Still in time</span>
                        {unavailable.supply.alternates.map((alternate) => (
                          <div key={alternate.optionId} className="flex items-center gap-3 border border-border bg-background px-2.5 py-1.5">
                            <span className="min-w-0 flex-1 truncate text-[12.5px]">{alternate.name}</span>
                            <span className="font-mono tabular-nums flex-none text-[12px]">{alternate.priceCents === 0 ? "Included" : money(alternate.priceCents)}</span>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 flex-none rounded-none"
                              disabled={pending || !sheet.canManage}
                              onClick={() => choose(activeCategory, alternate.optionId)}
                            >
                              Choose instead
                            </Button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-[11.5px] text-muted-foreground">No option in this category can arrive in time.</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {activeGroup && unavailable.code !== "SELECTION_OPTION_UNAVAILABLE" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 rounded-none"
                          disabled={!sheet.canManage}
                          onClick={() => setChanging({ group: activeGroup, initial: { selectionId: unavailable.selectionId, optionId: unavailable.optionId } })}
                        >
                          Draft a change order
                        </Button>
                      )}
                      <Button asChild size="sm" variant="ghost" className="h-7 rounded-none">
                        <Link href={`/projects/${sheet.home.projectId}/selections`}>Expedite or resolve on the project file</Link>
                      </Button>
                    </div>
                  </div>
                )}
                {activeCategory.options.length === 0 ? (
                  <p className="py-12 text-center text-[13px] text-muted-foreground">
                    No options are configured for this category yet.
                  </p>
                ) : (
                  <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(158px,1fr))]">
                    {activeCategory.options.map((option) => {
                      const picked = option.id === activeCategory.selectedOptionId
                      const locked = activeGroup?.status === "locked"
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className="studio-option"
                          data-picked={picked}
                          disabled={!option.isAvailable || locked || pending || !sheet.canManage}
                          onClick={() => choose(activeCategory, option.id)}
                        >
                          <span
                            className="studio-swatch"
                            data-generated={!option.imageUrl}
                            style={
                              {
                                backgroundImage: option.imageUrl ? `url(${option.imageUrl})` : undefined,
                                "--studio-swatch-hue": swatchHue(option.id),
                              } as React.CSSProperties
                            }
                          >
                            {option.isStandard && <span className="studio-tag">standard</span>}
                            {picked && (
                              <span className="studio-tag studio-land" style={{ left: "auto", right: 0 }}>
                                <Check className="h-2.5 w-2.5" />
                              </span>
                            )}
                            {!option.isAvailable && <span className="studio-tag">unavailable</span>}
                          </span>
                          <span
                            className="flex flex-col gap-0.5 border-t p-2.5 border-border"
                          >
                            <span className="text-[12.5px] font-medium">{option.name}</span>
                            <span className="font-mono tabular-nums text-[12.5px]">{priceLabel(option)}</span>
                            {showInternals && (
                              <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
                                {[option.sku, option.vendor, option.leadTimeDays ? `${option.leadTimeDays}d` : null]
                                  .filter(Boolean)
                                  .join(" · ") || "—"}
                                {option.costCents != null ? ` · cost ${money(option.costCents)}` : ""}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </section>

          <aside
            className="flex flex-col overflow-y-auto border-t lg:border-l lg:border-t-0 border-border bg-muted/40"
          >
            <div className="flex flex-1 flex-col gap-2.5 p-4">
              <p className="microlabel">Running total</p>
              <Row label={`Base price${sheet.home.planName ? ` · ${sheet.home.planName}` : ""}`} value={money(sheet.tally.basePriceCents)} />
              <Row label="Lot premium" value={money(sheet.tally.lotPremiumCents)} />
              {sheet.tally.byGroup.map((group) => (
                <Row
                  key={group.groupId}
                  label={`${group.name}${sheet.approvals.some((approval) => approval.groupId === group.groupId && approval.state === "approved") ? " (approved)" : group.locked ? " (locked)" : ""}`}
                  value={group.subtotalCents === 0 ? "—" : money(group.subtotalCents)}
                />
              ))}
            </div>
            {/* A spec with no agreement and no asking price has no contract
                total to show, so the options subtotal becomes the headline
                rather than rendering an em dash where the money goes. */}
            <div className="flex flex-col gap-1 border-t p-4 border-[var(--line-strong)]">
              <span className="text-[11.5px] text-muted-foreground">
                {sheet.tally.contractPriceCents === null ? "Options selected" : "Contract price today"}
              </span>
              <span className="font-mono tabular-nums studio-tick text-[27px] leading-none tracking-tight">
                {money(sheet.tally.contractPriceCents ?? sheet.tally.optionTotalCents)}
              </span>
              <span
                className={`text-[11.5px] ${
                  sheet.tally.contractPriceCents === null ? "text-muted-foreground" : "text-[var(--success)]"
                }`}
              >
                {sheet.tally.contractPriceCents === null
                  ? "No base price set for this home yet"
                  : `${money(sheet.tally.optionTotalCents)} in options selected`}
              </span>
            </div>
            {activeGroup && (
              <div className="flex flex-col gap-2 border-t p-4 border-border">
                {activeGroup.status === "locked" ? (
                  <Button
                    variant="outline"
                    className="w-full rounded-none"
                    disabled={!sheet.canManage}
                    onClick={() => setChanging({ group: activeGroup, initial: null })}
                  >
                    <Lock className="mr-1.5 h-3.5 w-3.5" />
                    Change via change order
                  </Button>
                ) : (
                  <SelectionApprovalPanel
                    projectId={sheet.home.projectId}
                    approval={sheet.approvals.find((approval) => approval.groupId === activeGroup.groupId) ?? null}
                    canManage={sheet.canManage}
                    layout="stack"
                  />
                )}
                <Button asChild variant="outline" className="w-full rounded-none">
                  <Link href={`/projects/${sheet.home.projectId}/selections`}>Open the project file</Link>
                </Button>
              </div>
            )}
          </aside>
        </div>
      )}

      {changing && (
        <PostCutoffChangeDialog
          open
          onOpenChange={(open) => {
            if (!open) setChanging(null)
          }}
          projectId={sheet.home.projectId}
          group={changing.group}
          initial={changing.initial}
          changeFeeCents={changing.group.status === "locked" ? sheet.changeFeeCents : 0}
          canWaiveChangeFee={sheet.canWaiveChangeFee}
        />
      )}

    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-[12px]">
      <span className="min-w-0 truncate text-muted-foreground">
        {label}
      </span>
      <span className="font-mono tabular-nums flex-none">{value}</span>
    </div>
  )
}
