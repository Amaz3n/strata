"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"

import type {
  BidPackage,
  BidScopeItem,
  BidSubmission,
  BidSubmissionItem,
} from "@/lib/services/bids"
import type { PackageIntelligence } from "@/lib/services/bid-intelligence"
import type { VendorBidStats } from "@/lib/services/bid-intelligence"
import {
  updateBidSubmissionItemLevelingAction,
  updateBidSubmissionLevelingAction,
} from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AlertTriangle, Gavel } from "@/components/icons"
import {
  computeSubmissionTotals,
  formatDeviationPercent,
  itemForScope,
  money,
  parseCurrencyToCents,
  type BidWorkbenchContext,
} from "@/components/bids/bid-workbench-helpers"

interface BidTabGridProps {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  submissions: BidSubmission[]
  scopeItems: BidScopeItem[]
  intelligence: PackageIntelligence | null
  vendorStats: Record<string, VendorBidStats>
  awarded: boolean
  onColumnClick: (submission: BidSubmission) => void
  onSubmissionChanged: (submission: BidSubmission) => void
}

const GROUPS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "base", label: "Base bid", types: ["base", "unit_price"] },
  { key: "alternate", label: "Alternates", types: ["alternate"] },
  { key: "allowance", label: "Allowances", types: ["allowance"] },
]

export function BidTabGrid({
  context,
  bidPackage,
  submissions,
  scopeItems,
  intelligence,
  vendorStats,
  awarded,
  onColumnClick,
  onSubmissionChanged,
}: BidTabGridProps) {
  const current = useMemo(
    () => submissions.filter((submission) => submission.is_current && submission.total_cents != null),
    [submissions],
  )

  const budgetTotal = useMemo(() => {
    const scopeBudget = scopeItems
      .filter((scope) => scope.item_type !== "alternate")
      .reduce((sum, scope) => sum + (scope.budget_cents ?? 0), 0)
    if (scopeBudget > 0) return scopeBudget
    return bidPackage.budget_cents ?? null
  }, [scopeItems, bidPackage.budget_cents])

  const showBudgetColumn = budgetTotal != null

  const totalsBySubmission = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeSubmissionTotals>>()
    for (const submission of current) {
      map.set(submission.id, computeSubmissionTotals(submission, scopeItems))
    }
    return map
  }, [current, scopeItems])

  const lowestLeveled = useMemo(() => {
    let min: { id: string; value: number } | null = null
    for (const submission of current) {
      const value = totalsBySubmission.get(submission.id)?.leveled ?? 0
      if (min == null || value < min.value) min = { id: submission.id, value }
    }
    return min
  }, [current, totalsBySubmission])

  if (current.length === 0) {
    return (
      <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
        No priced bids yet. Bids appear here as vendors submit through the portal or you enter them manually.
      </div>
    )
  }

  const groupedScope = GROUPS.map((group) => ({
    ...group,
    items: scopeItems.filter((scope) => group.types.includes(scope.item_type)),
  })).filter((group) => group.items.length > 0)

  const hasScope = scopeItems.length > 0

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b">
            <th className="sticky left-0 z-10 min-w-[220px] bg-background px-3 py-2 text-left font-medium">
              Scope
            </th>
            {showBudgetColumn ? (
              <th className="min-w-[110px] px-3 py-2 text-right font-medium text-muted-foreground">Budget</th>
            ) : null}
            {current.map((submission) => {
              const companyId = submission.invite?.company?.id
              const stats = companyId ? vendorStats[companyId] : undefined
              const prequal = submission.invite?.prequalification_warning
              const isWinner = awarded && submission.is_awarded
              return (
                <th
                  key={submission.id}
                  className={cn(
                    "min-w-[150px] cursor-pointer px-3 py-2 text-right align-bottom font-medium hover:bg-muted/40",
                    isWinner && "bg-success/5",
                  )}
                  onClick={() => onColumnClick(submission)}
                >
                  <div className="flex items-center justify-end gap-1.5">
                    {isWinner ? <Gavel className="h-3.5 w-3.5 text-success" /> : null}
                    <span className="truncate">{submission.invite?.company?.name ?? "Vendor"}</span>
                    {prequal ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{prequal}</TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                  {stats?.change_order_growth_pct != null && stats.change_order_growth_pct !== 0 ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="mt-1 inline-block border border-warning/30 px-1 text-[10px] font-normal text-warning">
                          CO +{stats.change_order_growth_pct}%
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        Historic change-order growth on this vendor&apos;s awards
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {hasScope ? (
            groupedScope.map((group) => (
              <GroupRows
                key={group.key}
                context={context}
                label={group.label}
                items={group.items}
                submissions={current}
                showBudgetColumn={showBudgetColumn}
                awarded={awarded}
                onSubmissionChanged={onSubmissionChanged}
              />
            ))
          ) : (
            <>
              <tr className="border-b">
                <td className="sticky left-0 z-10 bg-background px-3 py-2 text-muted-foreground">Total bid</td>
                {showBudgetColumn ? (
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(budgetTotal)}</td>
                ) : null}
                {current.map((submission) => (
                  <td key={submission.id} className="px-3 py-2 text-right tabular-nums">
                    {money(submission.total_cents)}
                  </td>
                ))}
              </tr>
              <tr className="border-b">
                <td className="sticky left-0 z-10 bg-background px-3 py-2 align-top text-xs text-muted-foreground">
                  Exclusions
                </td>
                {showBudgetColumn ? <td /> : null}
                {current.map((submission) => (
                  <td key={submission.id} className="px-3 py-2 text-right align-top">
                    {submission.exclusions ? (
                      <span className="text-xs text-muted-foreground">{submission.exclusions}</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                ))}
              </tr>
            </>
          )}
        </tbody>
        <tfoot className="border-t-2">
          <TotalsRow
            label="Base total"
            showBudgetColumn={showBudgetColumn}
            budget={budgetTotal}
            submissions={current}
            value={(submission) => totalsBySubmission.get(submission.id)?.base ?? 0}
          />
          {hasScope ? (
            <tr className="border-t">
              <td className="sticky left-0 z-10 bg-background px-3 py-1.5 text-xs text-muted-foreground">
                Leveling adj
              </td>
              {showBudgetColumn ? <td /> : null}
              {current.map((submission) => (
                <td key={submission.id} className="px-2 py-1.5 text-right">
                  <LumpAdjustInput
                    context={context}
                    submission={submission}
                    disabled={awarded}
                    onSubmissionChanged={onSubmissionChanged}
                  />
                </td>
              ))}
            </tr>
          ) : null}
          <tr className="border-t bg-muted/30 font-medium">
            <td className="sticky left-0 z-10 bg-muted/30 px-3 py-2">Leveled total</td>
            {showBudgetColumn ? (
              <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(budgetTotal)}</td>
            ) : null}
            {current.map((submission) => {
              const totals = totalsBySubmission.get(submission.id)
              const isLowest = lowestLeveled?.id === submission.id
              const signal = intelligence?.signals.find((entry) => entry.bid_submission_id === submission.id)
              return (
                <td
                  key={submission.id}
                  className={cn("px-3 py-2 text-right tabular-nums", isLowest && "bg-success/10 text-success")}
                >
                  <div className="flex items-center justify-end gap-1">
                    {signal?.is_low_outlier ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          {formatDeviationPercent(signal.deviation_from_median_pct)} vs peer median — check scope
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                    {money(totals?.leveled ?? 0)}
                  </div>
                </td>
              )
            })}
          </tr>
          <tr className="border-t">
            <td className="sticky left-0 z-10 bg-background px-3 py-1.5 text-xs text-muted-foreground">Δ Budget</td>
            {showBudgetColumn ? <td /> : null}
            {current.map((submission) => {
              const leveled = totalsBySubmission.get(submission.id)?.leveled ?? 0
              const deltaPct = budgetTotal && budgetTotal > 0 ? ((leveled - budgetTotal) / budgetTotal) * 100 : null
              return (
                <td
                  key={submission.id}
                  className={cn(
                    "px-3 py-1.5 text-right tabular-nums text-xs",
                    deltaPct == null && "text-muted-foreground",
                    deltaPct != null && deltaPct > 0 && "text-destructive",
                    deltaPct != null && deltaPct <= 0 && "text-success",
                  )}
                >
                  {deltaPct == null ? "—" : formatDeviationPercent(deltaPct)}
                </td>
              )
            })}
          </tr>
          <tr className="border-t">
            <td className="sticky left-0 z-10 bg-background px-3 py-1.5 text-[11px] text-muted-foreground">
              Market range
            </td>
            {showBudgetColumn ? <td /> : null}
            {current.map((submission) => {
              const benchmark = submission.benchmark
              const stale = intelligence?.signals.find(
                (entry) => entry.bid_submission_id === submission.id,
              )?.is_stale_vs_addenda
              return (
                <td key={submission.id} className="px-3 py-1.5 text-right align-top text-[11px] text-muted-foreground">
                  {benchmark?.has_benchmark ? (
                    <div className="tabular-nums">
                      {money(benchmark.p25_cents)}–{money(benchmark.p75_cents)}
                      {benchmark.deviation_pct != null ? (
                        <span className="ml-1">{formatDeviationPercent(benchmark.deviation_pct)}</span>
                      ) : null}
                    </div>
                  ) : (
                    <span>—</span>
                  )}
                  {stale ? (
                    <div className="mt-0.5 text-warning">predates latest addendum</div>
                  ) : null}
                </td>
              )
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

function GroupRows({
  context,
  label,
  items,
  submissions,
  showBudgetColumn,
  awarded,
  onSubmissionChanged,
}: {
  context: BidWorkbenchContext
  label: string
  items: BidScopeItem[]
  submissions: BidSubmission[]
  showBudgetColumn: boolean
  awarded: boolean
  onSubmissionChanged: (submission: BidSubmission) => void
}) {
  const colSpan = 1 + (showBudgetColumn ? 1 : 0) + submissions.length
  return (
    <>
      <tr className="border-b bg-muted/20">
        <td colSpan={colSpan} className="sticky left-0 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </td>
      </tr>
      {items.map((scope) => (
        <tr key={scope.id} className="border-b">
          <td className="sticky left-0 z-10 bg-background px-3 py-2">
            <div>{scope.description}</div>
            {scope.quantity != null ? (
              <div className="text-xs text-muted-foreground">
                {scope.quantity} {scope.unit ?? ""}
              </div>
            ) : null}
          </td>
          {showBudgetColumn ? (
            <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{money(scope.budget_cents)}</td>
          ) : null}
          {submissions.map((submission) => (
            <td key={submission.id} className="px-2 py-2 text-right">
              <ScopeCell
                context={context}
                submission={submission}
                item={itemForScope(submission, scope.id)}
                disabled={awarded}
                onSubmissionChanged={onSubmissionChanged}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

function ScopeCell({
  context,
  submission,
  item,
  disabled,
  onSubmissionChanged,
}: {
  context: BidWorkbenchContext
  submission: BidSubmission
  item: BidSubmissionItem | undefined
  disabled: boolean
  onSubmissionChanged: (submission: BidSubmission) => void
}) {
  if (!item) {
    return <span className="text-muted-foreground">—</span>
  }
  if (item.response === "priced") {
    return <span className="tabular-nums">{money(item.amount_cents)}</span>
  }

  const plugged = item.gc_plug_cents != null
  const trigger = (
    <button
      type="button"
      className={cn(
        "text-right",
        plugged ? "border border-warning/40 px-1 italic tabular-nums text-warning" : "text-muted-foreground",
        !disabled && "hover:underline",
      )}
    >
      {plugged ? money(item.gc_plug_cents) : item.response === "excluded" ? "excl" : "—"}
    </button>
  )

  if (disabled) {
    return trigger
  }

  return (
    <PlugPopover context={context} submission={submission} item={item} onSubmissionChanged={onSubmissionChanged}>
      {trigger}
    </PlugPopover>
  )
}

function PlugPopover({
  context,
  submission,
  item,
  onSubmissionChanged,
  children,
}: {
  context: BidWorkbenchContext
  submission: BidSubmission
  item: BidSubmissionItem
  onSubmissionChanged: (submission: BidSubmission) => void
  children: React.ReactNode
}) {
  const [plug, setPlug] = useState(item.gc_plug_cents != null ? String(item.gc_plug_cents / 100) : "")
  const [note, setNote] = useState(item.gc_note ?? "")

  async function persist() {
    const plugCents = plug.trim() ? parseCurrencyToCents(plug) : null
    if (plugCents != null && Number.isNaN(plugCents)) {
      toast.error("Enter a valid plug amount")
      return
    }
    if ((plugCents ?? null) === (item.gc_plug_cents ?? null) && note === (item.gc_note ?? "")) {
      return
    }
    try {
      const saved = unwrapAction(
        await updateBidSubmissionItemLevelingAction(
          { ...context, bidPackageId: submission.invite?.bid_package_id },
          { bid_submission_item_id: item.id, gc_plug_cents: plugCents, gc_note: note.trim() || null },
        ),
      )
      onSubmissionChanged({
        ...submission,
        items: (submission.items ?? []).map((entry) => (entry.id === saved.id ? saved : entry)),
      })
    } catch (error) {
      toast.error("Failed to save plug", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="end" className="w-56 space-y-2">
        <div className="text-xs font-medium">GC plug for excluded scope</div>
        <Input
          value={plug}
          inputMode="decimal"
          placeholder="$0"
          className="h-8 text-right tabular-nums"
          onChange={(event) => setPlug(event.target.value)}
          onBlur={persist}
        />
        <Textarea
          value={note}
          placeholder="Note (optional)"
          rows={2}
          className="text-xs"
          onChange={(event) => setNote(event.target.value)}
          onBlur={persist}
        />
      </PopoverContent>
    </Popover>
  )
}

function LumpAdjustInput({
  context,
  submission,
  disabled,
  onSubmissionChanged,
}: {
  context: BidWorkbenchContext
  submission: BidSubmission
  disabled: boolean
  onSubmissionChanged: (submission: BidSubmission) => void
}) {
  const [value, setValue] = useState(
    submission.leveled_adjustment_cents ? String(submission.leveled_adjustment_cents / 100) : "",
  )

  async function persist() {
    const cents = value.trim() ? parseCurrencyToCents(value) : 0
    if (Number.isNaN(cents)) {
      toast.error("Enter a valid adjustment")
      return
    }
    if (cents === (submission.leveled_adjustment_cents ?? 0)) return
    try {
      const saved = unwrapAction(
        await updateBidSubmissionLevelingAction(
          { ...context, bidPackageId: submission.invite?.bid_package_id },
          {
            bid_submission_id: submission.id,
            leveled_adjustment_cents: cents,
            leveling_notes: submission.leveling_notes ?? null,
          },
        ),
      )
      onSubmissionChanged({ ...submission, leveled_adjustment_cents: saved.leveled_adjustment_cents })
    } catch (error) {
      toast.error("Failed to save adjustment", {
        description: error instanceof Error ? error.message : "Please try again.",
      })
    }
  }

  return (
    <Input
      value={value}
      disabled={disabled}
      inputMode="decimal"
      placeholder="$0"
      className="h-7 text-right tabular-nums"
      onChange={(event) => setValue(event.target.value)}
      onBlur={persist}
    />
  )
}

function TotalsRow({
  label,
  showBudgetColumn,
  budget,
  submissions,
  value,
}: {
  label: string
  showBudgetColumn: boolean
  budget: number | null
  submissions: BidSubmission[]
  value: (submission: BidSubmission) => number
}) {
  return (
    <tr className="border-t">
      <td className="sticky left-0 z-10 bg-background px-3 py-1.5 text-xs font-medium">{label}</td>
      {showBudgetColumn ? (
        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{money(budget)}</td>
      ) : null}
      {submissions.map((submission) => (
        <td key={submission.id} className="px-3 py-1.5 text-right tabular-nums">
          {money(value(submission))}
        </td>
      ))}
    </tr>
  )
}
