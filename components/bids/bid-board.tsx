"use client"

import { Fragment, useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidInvite, BidPackage, BidScopeItem, BidSubmission } from "@/lib/services/bids"
import type { BidOutlierSignal } from "@/lib/services/bid-intelligence"
import type { BidScopeItemType } from "@/lib/validation/bids"
import { itemForScope, type SubmissionTotals } from "@/lib/bids/leveling"
import { TRADE_STATE_LABELS, tradeHasPrices, type TradeState } from "@/lib/bids/package-move"
import { saveBidScopeItemsAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { cn, formatMoneyCents } from "@/lib/utils"
import { TakeoffLineBadge } from "@/components/takeoff/takeoff-line-badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AlertTriangle, Plus, Trash2 } from "@/components/icons"
import {
  formatDeviationPercent,
  parseCurrencyToCents,
  signedMoney,
  type BidWorkbenchContext,
} from "@/components/bids/bid-workbench-helpers"

/** One invited trade as the board draws it. Built by the workbench. */
export interface TradeColumn {
  invite: BidInvite
  name: string
  state: TradeState
  submission: BidSubmission | null
  totals: SubmissionTotals | null
  unpluggedLines: number
}

export type BoardSelection =
  | { kind: "trade"; inviteId: string }
  | { kind: "cell"; inviteId: string; scopeId: string }
  | null

const GROUPS: Array<{ key: BidScopeItemType; label: string; types: BidScopeItemType[] }> = [
  { key: "base", label: "Base bid", types: ["base", "unit_price"] },
  { key: "allowance", label: "Allowances", types: ["allowance"] },
  { key: "alternate", label: "Alternates", types: ["alternate"] },
]

const STATE_TONE: Record<TradeState, string> = {
  lined_up: "text-muted-foreground",
  sent: "text-muted-foreground",
  opened: "text-primary",
  declined: "text-destructive",
  withdrawn: "text-muted-foreground",
  priced: "text-success",
  stale: "text-warning",
  no_response: "text-warning",
  awarded: "text-success",
  not_selected: "text-muted-foreground",
}

interface ScopeDraft {
  key: string
  id: string | null
  item_type: BidScopeItemType
  description: string
  quantity: string
  unit: string
  budget: string
  metadata: Record<string, unknown> | null
}

let draftSeq = 0
const toDraft = (item: BidScopeItem): ScopeDraft => ({
  key: item.id,
  id: item.id,
  item_type: item.item_type,
  description: item.description,
  quantity: item.quantity != null ? String(item.quantity) : "",
  unit: item.unit ?? "",
  budget: item.budget_cents != null ? String(item.budget_cents / 100) : "",
  metadata: item.metadata ?? null,
})
const blankDraft = (item_type: BidScopeItemType): ScopeDraft => {
  draftSeq += 1
  return { key: `new-${draftSeq}`, id: null, item_type, description: "", quantity: "", unit: "", budget: "", metadata: null }
}
const fingerprint = (rows: ScopeDraft[]) =>
  JSON.stringify(rows.map(({ id, item_type, description, quantity, unit, budget }) => [id, item_type, description, quantity, unit, budget]))

/**
 * The package as one grid: scope lines are the rows, invited trades are the
 * columns, prices fill the cells. It grows left to right as the package
 * matures, so there is nothing else to learn. While the package is a draft
 * the scope column is edited in place.
 */
export function BidBoard({
  context,
  bidPackage,
  scopeItems,
  columns,
  editableScope,
  canAddTrades,
  selection,
  signals,
  onSelect,
  onScopeSaved,
  onAddTrades,
  onNudge,
  onRemove,
  onEnterPrice,
}: {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  scopeItems: BidScopeItem[]
  columns: TradeColumn[]
  editableScope: boolean
  canAddTrades: boolean
  selection: BoardSelection
  signals: BidOutlierSignal[]
  onSelect: (selection: BoardSelection) => void
  onScopeSaved: (items: BidScopeItem[]) => void
  onAddTrades: () => void
  onNudge: (invite: BidInvite) => void
  onRemove: (invite: BidInvite) => void
  onEnterPrice: (invite: BidInvite) => void
}) {
  const [rows, setRows] = useState<ScopeDraft[]>(() => scopeItems.map(toDraft))
  const [baseline, setBaseline] = useState(() => fingerprint(scopeItems.map(toDraft)))
  const [source, setSource] = useState(scopeItems)
  const [isSaving, startSaving] = useTransition()
  if (source !== scopeItems) {
    setSource(scopeItems)
    setRows(scopeItems.map(toDraft))
    setBaseline(fingerprint(scopeItems.map(toDraft)))
  }
  const dirty = editableScope && fingerprint(rows) !== baseline

  const priced = columns.filter((column) => tradeHasPrices(column.state))
  const quoteOnly = scopeItems.length === 0 && !editableScope
  const budgetTotal = useMemo(() => {
    const lines = scopeItems.filter((scope) => scope.item_type !== "alternate").reduce((sum, scope) => sum + (scope.budget_cents ?? 0), 0)
    return lines > 0 ? lines : bidPackage.budget_cents ?? null
  }, [scopeItems, bidPackage.budget_cents])
  const lowLeveled = priced.length > 1 ? Math.min(...priced.map((column) => column.totals?.leveled ?? Number.POSITIVE_INFINITY)) : null
  const showPlugs = priced.some((column) => (column.totals?.plugs ?? 0) !== 0 || column.unpluggedLines > 0)
  const showLump = priced.some((column) => (column.totals?.lump ?? 0) !== 0)

  const groups = GROUPS.map((group) => ({
    ...group,
    rows: (editableScope ? rows : scopeItems.map(toDraft)).filter((row) => group.types.includes(row.item_type)),
  })).filter((group) => editableScope || group.rows.length > 0)

  // Every tbody row, counted once, so a waiting trade's column can be one tall cell.
  const bodyRowCount = quoteOnly ? 1 : groups.reduce((sum, group) => sum + 1 + group.rows.length + (editableScope ? 1 : 0), 0)

  function update(key: string, patch: Partial<ScopeDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function saveScope() {
    if (rows.some((row) => !row.description.trim())) {
      toast.error("Every scope line needs a description")
      return
    }
    startSaving(async () => {
      try {
        const saved = unwrapAction(
          await saveBidScopeItemsAction(
            { ...context, bidPackageId: bidPackage.id },
            {
              bid_package_id: bidPackage.id,
              items: rows.map((row) => ({
                id: row.id ?? undefined,
                item_type: row.item_type,
                description: row.description.trim(),
                quantity: row.quantity.trim() ? Number(row.quantity) : null,
                unit: row.unit.trim() || null,
                budget_cents: row.budget.trim() ? parseCurrencyToCents(row.budget) : null,
              })),
            },
          ),
        )
        onScopeSaved(saved)
        toast.success("Scope saved")
      } catch (error) {
        toast.error("Scope not saved", { description: error instanceof Error ? error.message : "Please try again." })
      }
    })
  }

  const lowFor = (scopeId: string) => {
    const values = priced
      .map((column) => (column.submission ? itemForScope(column.submission, scopeId) : undefined))
      .filter((item) => item?.response === "priced" && item.amount_cents != null)
      .map((item) => item?.amount_cents ?? 0)
    return values.length > 1 ? Math.min(...values) : null
  }

  const columnTone = (column: TradeColumn, inviteSelected: boolean) =>
    cn(
      column.state === "awarded" && "bg-success/[0.06]",
      column.state === "not_selected" && "opacity-50",
      inviteSelected && column.state !== "awarded" && "bg-primary/[0.05]",
    )
  const isSelectedTrade = (column: TradeColumn) =>
    selection != null && selection.inviteId === column.invite.id

  const firstGroup = groups[0]?.key
  const waitingCell = (column: TradeColumn) => {
    const selected = isSelectedTrade(column)
    const action =
      column.state === "lined_up" ? (
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-destructive" onClick={(event) => { event.stopPropagation(); onRemove(column.invite) }}>
          Remove
        </Button>
      ) : column.state === "declined" || column.state === "withdrawn" ? null : (
        <div className="flex flex-col items-center gap-1">
          {column.state !== "no_response" || bidPackage.status !== "closed" ? (
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={(event) => { event.stopPropagation(); onNudge(column.invite) }}>
              {column.state === "stale" ? "Ask for a fresh price" : column.state === "no_response" ? "Ask for a late bid" : "Nudge"}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={(event) => { event.stopPropagation(); onEnterPrice(column.invite) }}>
            Enter their price
          </Button>
        </div>
      )
    const reason =
      column.state === "lined_up" ? "Hears nothing until you send"
      : column.state === "declined" ? "Declined to bid"
      : column.state === "withdrawn" ? "Withdrew their bid"
      : column.state === "stale" ? "Their price no longer matches this scope"
      : column.state === "no_response" ? "No price by the deadline"
      : column.state === "opened" ? "Opened the package"
      : "Hasn't opened it yet"
    return (
      <td
        key={column.invite.id}
        rowSpan={bodyRowCount}
        onClick={() => onSelect({ kind: "trade", inviteId: column.invite.id })}
        className={cn("cursor-pointer border-l px-3 text-center align-middle", columnTone(column, selected), "bg-[repeating-linear-gradient(135deg,transparent_0_7px,color-mix(in_oklab,var(--border)_45%,transparent)_7px_8px)]")}
      >
        <div className="inline-flex max-w-[11rem] flex-col items-center gap-2 border bg-card px-3 py-3 text-xs text-muted-foreground">
          <span>{reason}</span>
          {action}
        </div>
      </td>
    )
  }

  return (
    <section className="min-w-0 border bg-card" aria-label="Bid board">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b">
              <th className="sticky left-0 z-10 min-w-[260px] bg-card px-4 pb-2.5 pt-4 text-left align-bottom">
                <span className="microlabel">Scope</span>
              </th>
              <th className="min-w-[96px] px-3 pb-2.5 pt-4 text-right align-bottom">
                <span className="microlabel">Budget</span>
              </th>
              {columns.map((column) => {
                const selected = isSelectedTrade(column)
                const warning = column.invite.prequalification_warning || column.invite.compliance_warning
                return (
                  <th
                    key={column.invite.id}
                    className={cn("relative min-w-[140px] border-l p-0 align-bottom", columnTone(column, selected))}
                  >
                    {selected || column.state === "awarded" ? (
                      <span className={cn("absolute inset-x-0 top-0 h-0.5", column.state === "awarded" ? "bg-success" : "bg-primary")} />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => onSelect(selected && selection?.kind === "trade" ? null : { kind: "trade", inviteId: column.invite.id })}
                      className="group flex w-full flex-col items-end gap-1 px-3 pb-2.5 pt-4 text-right outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="flex max-w-[12rem] items-center gap-1.5 font-semibold transition-colors group-hover:text-primary">
                        {warning ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={warning} /> : null}
                        <span className="truncate">{column.name}</span>
                      </span>
                      <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] font-medium", STATE_TONE[column.state])}>
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                        {TRADE_STATE_LABELS[column.state]}
                      </span>
                    </button>
                  </th>
                )
              })}
              {canAddTrades ? (
                <th className="border-l p-0 align-middle">
                  <button
                    type="button"
                    onClick={onAddTrades}
                    className="flex h-full min-h-[64px] w-full min-w-[112px] items-center justify-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Trade
                  </button>
                </th>
              ) : null}
            </tr>
          </thead>

          <tbody>
            {quoteOnly ? (
              <tr className="border-b">
                <td className="sticky left-0 z-10 bg-card px-4 py-3">
                  <p className="font-medium">Lump sum</p>
                  <p className="text-xs text-muted-foreground">Trades price this package as one number</p>
                </td>
                <td className="px-3 text-right font-mono tabular-nums text-muted-foreground">{formatMoneyCents(budgetTotal)}</td>
                {columns.map((column) =>
                  tradeHasPrices(column.state) ? (
                    <td key={column.invite.id} className={cn("border-l px-3 text-right font-mono tabular-nums", columnTone(column, isSelectedTrade(column)))}>
                      {formatMoneyCents(column.submission?.total_cents ?? null)}
                    </td>
                  ) : (
                    waitingCell(column)
                  ),
                )}
                {canAddTrades ? <td className="border-l" /> : null}
              </tr>
            ) : (
              groups.map((group) => (
                <Fragment key={group.key}>
                  <tr className="border-b bg-muted/40">
                    <td colSpan={2} className="sticky left-0 z-10 bg-muted/40 px-4 py-1.5">
                      <span className="microlabel">{group.label}</span>
                    </td>
                    {columns.map((column) => {
                      if (tradeHasPrices(column.state)) return <td key={column.invite.id} className={cn("border-l", columnTone(column, isSelectedTrade(column)))} />
                      // A waiting trade is one tall cell, opened on the first body row.
                      return group.key === firstGroup ? waitingCell(column) : null
                    })}
                    {canAddTrades ? <td className="border-l" /> : null}
                  </tr>
                  {group.rows.map((row) => {
                    const low = editableScope || !row.id ? null : lowFor(row.id)
                    return (
                      <tr key={row.key} className="group/row border-b transition-colors hover:bg-muted/30">
                        <td className="sticky left-0 z-10 bg-card px-4 py-2 transition-colors group-hover/row:bg-muted/30">
                          {editableScope ? (
                            <div className="flex items-start gap-2">
                              <div className="min-w-0 flex-1 space-y-1">
                                <Input
                                  aria-label="Scope line"
                                  value={row.description}
                                  placeholder="Describe the work"
                                  onChange={(event) => update(row.key, { description: event.target.value })}
                                  className="h-8 border-transparent px-1.5 font-medium shadow-none hover:border-border focus-visible:border-border"
                                />
                                <div className="flex gap-1">
                                  <Input aria-label="Quantity" inputMode="decimal" placeholder="Qty" value={row.quantity} onChange={(event) => update(row.key, { quantity: event.target.value })} className="h-7 w-20 border-transparent px-1.5 text-xs tabular-nums shadow-none hover:border-border" />
                                  <Input aria-label="Unit" placeholder="Unit" value={row.unit} onChange={(event) => update(row.key, { unit: event.target.value })} className="h-7 w-16 border-transparent px-1.5 text-xs shadow-none hover:border-border" />
                                </div>
                              </div>
                              <Button variant="ghost" size="icon" className="mt-0.5 h-7 w-7 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100" aria-label="Remove line" onClick={() => setRows((current) => current.filter((entry) => entry.key !== row.key))}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <>
                              <p className="font-medium">{row.description}</p>
                              {row.quantity ? <p className="text-xs text-muted-foreground">{row.quantity} {row.unit}</p> : null}
                            </>
                          )}
                          {row.metadata ? <TakeoffLineBadge metadata={row.metadata} liveQuantity={row.quantity} projectId={context.projectId} className="mt-1" /> : null}
                        </td>
                        <td className="px-3 text-right align-middle">
                          {editableScope && row.item_type !== "alternate" ? (
                            <Input aria-label="Budget" inputMode="decimal" placeholder="$0" value={row.budget} onChange={(event) => update(row.key, { budget: event.target.value })} className="ml-auto h-8 w-24 border-transparent px-1.5 text-right font-mono tabular-nums shadow-none hover:border-border" />
                          ) : (
                            <span className="font-mono tabular-nums text-muted-foreground">{row.item_type === "alternate" ? "" : formatMoneyCents(row.budget ? parseCurrencyToCents(row.budget) : null)}</span>
                          )}
                        </td>
                        {columns.map((column) => {
                          if (!tradeHasPrices(column.state)) return null
                          const item = column.submission && row.id ? itemForScope(column.submission, row.id) : undefined
                          const cellSelected = selection?.kind === "cell" && selection.inviteId === column.invite.id && selection.scopeId === row.id
                          return (
                            <td
                              key={column.invite.id}
                              className={cn(
                                "cursor-pointer border-l px-3 text-right align-middle",
                                columnTone(column, isSelectedTrade(column)),
                                cellSelected && "shadow-[inset_0_0_0_1.5px_var(--color-primary)]",
                              )}
                              onClick={() => row.id && onSelect(cellSelected ? null : { kind: "cell", inviteId: column.invite.id, scopeId: row.id })}
                            >
                              <PriceCell itemResponse={item?.response} amount={item?.amount_cents ?? null} plug={item?.gc_plug_cents ?? null} isLow={low != null && item?.amount_cents === low} alternate={row.item_type === "alternate"} />
                            </td>
                          )
                        })}
                        {canAddTrades ? <td className="border-l" /> : null}
                      </tr>
                    )
                  })}
                  {editableScope ? (
                    <tr className="border-b">
                      <td colSpan={2} className="sticky left-0 z-10 bg-card px-3 py-1">
                        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-primary" data-add-scope={group.key === "base" ? "" : undefined} onClick={() => setRows((current) => [...current, blankDraft(group.key)])}>
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          {group.key === "base" ? "Scope line" : group.key === "allowance" ? "Allowance" : "Alternate"}
                        </Button>
                      </td>
                      {columns.map((column) => (tradeHasPrices(column.state) ? <td key={column.invite.id} className="border-l" /> : null))}
                      {canAddTrades ? <td className="border-l" /> : null}
                    </tr>
                  ) : null}
                </Fragment>
              ))
            )}
          </tbody>

          {priced.length > 0 ? (
            <tfoot>
              <FootRow label="As bid" budget={budgetTotal} columns={columns} canAddTrades={canAddTrades} tone={columnTone} selected={isSelectedTrade}
                value={(column) => <span className="font-mono tabular-nums">{formatMoneyCents(column.totals?.base ?? null)}</span>} />
              {showPlugs ? (
                <FootRow label="Plugs for excluded scope" columns={columns} canAddTrades={canAddTrades} tone={columnTone} selected={isSelectedTrade}
                  value={(column) =>
                    column.unpluggedLines > 0 ? (
                      <span className="text-xs font-medium text-warning">{column.unpluggedLines} unplugged</span>
                    ) : column.totals?.plugs ? (
                      <span className="font-mono tabular-nums text-warning">{signedMoney(column.totals.plugs)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )
                  } />
              ) : null}
              {showLump ? (
                <FootRow label="Leveling adjustment" columns={columns} canAddTrades={canAddTrades} tone={columnTone} selected={isSelectedTrade}
                  value={(column) => (column.totals?.lump ? <span className="font-mono tabular-nums">{signedMoney(column.totals.lump)}</span> : <span className="text-muted-foreground">—</span>)} />
              ) : null}
              <FootRow strong label="Leveled total" budget={budgetTotal} columns={columns} canAddTrades={canAddTrades} tone={columnTone} selected={isSelectedTrade}
                value={(column) => {
                  const leveled = column.totals?.leveled ?? null
                  const signal = signals.find((entry) => entry.bid_submission_id === column.submission?.id)
                  return (
                    <span className="inline-flex items-center justify-end gap-1.5">
                      {signal?.is_low_outlier ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <AlertTriangle className="h-3.5 w-3.5 text-warning" aria-label="Low outlier" />
                          </TooltipTrigger>
                          <TooltipContent>{formatDeviationPercent(signal.deviation_from_median_pct)} vs the other bids. Walk the scope with them before you award.</TooltipContent>
                        </Tooltip>
                      ) : null}
                      <span className={cn("font-mono tabular-nums", lowLeveled != null && leveled === lowLeveled && "text-success")}>{formatMoneyCents(leveled)}</span>
                    </span>
                  )
                }} />
              {budgetTotal ? (
                <FootRow label="vs budget" columns={columns} canAddTrades={canAddTrades} tone={columnTone} selected={isSelectedTrade}
                  value={(column) => {
                    const leveled = column.totals?.leveled
                    if (leveled == null) return null
                    const pct = ((leveled - budgetTotal) / budgetTotal) * 100
                    return <span className={cn("font-mono text-xs tabular-nums", pct > 0 ? "text-destructive" : "text-success")}>{formatDeviationPercent(pct)}</span>
                  }} />
              ) : null}
            </tfoot>
          ) : null}
        </table>
      </div>

      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
        {dirty ? (
          <>
            <span className="font-medium text-foreground">Unsaved scope changes</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-7" onClick={() => setRows(scopeItems.map(toDraft))} disabled={isSaving}>Discard</Button>
              <Button size="sm" className="h-7" onClick={saveScope} disabled={isSaving}>{isSaving ? "Saving…" : "Save scope"}</Button>
            </div>
          </>
        ) : (
          <>
            <span>
              {editableScope
                ? "Edit the scope in place. Trades price exactly these lines."
                : priced.length
                  ? "Click a trade to see its bid. Click a price to level it."
                  : "Prices appear here as trades submit."}
            </span>
            <span>Scope revision {bidPackage.scope_revision ?? 1}</span>
          </>
        )}
      </div>
    </section>
  )
}

function PriceCell({
  itemResponse,
  amount,
  plug,
  isLow,
  alternate,
}: {
  itemResponse: string | undefined
  amount: number | null
  plug: number | null
  isLow: boolean
  alternate: boolean
}) {
  if (!itemResponse) return <span className="text-muted-foreground">—</span>
  if (itemResponse === "priced") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 font-mono tabular-nums", isLow && "font-medium text-success")}>
        {isLow ? <span className="h-1.5 w-1.5 rounded-full bg-success" /> : null}
        {formatMoneyCents(amount)}
      </span>
    )
  }
  if (alternate) return <span className="text-muted-foreground">No bid</span>
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span className="text-xs font-medium text-warning">{itemResponse === "excluded" ? "Excluded" : "No bid"}</span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{plug != null ? `+${formatMoneyCents(plug)} plug` : "needs a plug"}</span>
    </span>
  )
}

function FootRow({
  label,
  budget,
  strong,
  columns,
  canAddTrades,
  tone,
  selected,
  value,
}: {
  label: string
  budget?: number | null
  strong?: boolean
  columns: TradeColumn[]
  canAddTrades: boolean
  tone: (column: TradeColumn, selected: boolean) => string
  selected: (column: TradeColumn) => boolean
  value: (column: TradeColumn) => React.ReactNode
}) {
  return (
    <tr className={cn(strong ? "border-y border-t-foreground/70 text-sm font-semibold" : "border-b text-muted-foreground")}>
      <td className={cn("sticky left-0 z-10 bg-card px-4", strong ? "h-11" : "h-9")}>{label}</td>
      <td className="px-3 text-right font-mono tabular-nums">{budget != null ? formatMoneyCents(budget) : null}</td>
      {columns.map((column) => (
        <td key={column.invite.id} className={cn("border-l px-3 text-right", tone(column, selected(column)), strong && "text-foreground")}>
          {columnHasPrices(column) ? value(column) : null}
        </td>
      ))}
      {canAddTrades ? <td className="border-l" /> : null}
    </tr>
  )
}

const columnHasPrices = (column: TradeColumn) => tradeHasPrices(column.state)
