"use client"

import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, MoreHorizontal } from "lucide-react"

import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import { COST_TYPE_LABELS } from "@/lib/cost-types"
import {
  buyoutClassName,
  dollarsToCents,
  formatBuyoutLabel,
  formatCurrency,
  Hint,
  type UnifiedBudgetRow,
} from "./shared"

/** Click-to-edit currency cell used for the budget amount in the table. */
function InlineBudgetAmount({
  cents,
  editable,
  onCommit,
}: {
  cents: number
  editable: boolean
  onCommit: (amountDollars: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState("")

  if (!editable) {
    return <span className="text-sm font-medium">{formatCurrency(cents)}</span>
  }

  if (editing) {
    return (
      <Input
        autoFocus
        inputMode="decimal"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onBlur={() => {
          setEditing(false)
          onCommit(value)
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            setEditing(false)
            onCommit(value)
          } else if (event.key === "Escape") {
            event.preventDefault()
            setEditing(false)
          }
        }}
        className="ml-auto h-7 w-[110px] text-right text-sm tabular-nums"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        setValue((cents / 100).toFixed(2))
        setEditing(true)
      }}
      className="ml-auto px-1.5 py-0.5 text-sm font-medium tabular-nums hover:bg-muted hover:ring-1 hover:ring-border"
      title="Click to edit"
    >
      {formatCurrency(cents)}
    </button>
  )
}

function StatusDot({ status, className }: { status: string; className?: string }) {
  return status === "over" ? (
    <span className={cn("h-1.5 w-1.5 rounded-full bg-destructive", className)} aria-label="Over budget" />
  ) : status === "warning" ? (
    <span className={cn("h-1.5 w-1.5 rounded-full bg-warning", className)} aria-label="Near budget" />
  ) : (
    <span className={cn("h-1.5 w-1.5 rounded-full bg-muted-foreground/30", className)} />
  )
}

type ColumnTotals = {
  budgetCents: number
  baselineCents: number
  coAdjustmentCents: number
  adjustedBudgetCents: number
  committedCents: number
  committedBilledCents: number
  remainingCommitmentCents: number
  pendingCostCents: number
  exposureCents: number
  actualCents: number
  costToCompleteCents: number
  eacCents: number
  varianceAtCompletionCents: number
  remainingToBuyCents: number
  leftToSpendCents: number
}

export function sumBudgetRows(rows: UnifiedBudgetRow[]): ColumnTotals {
  return rows.reduce(
    (acc, row) => {
      acc.budgetCents += row.budgetCents
      acc.baselineCents += row.baselineCents ?? row.budgetCents
      acc.coAdjustmentCents += row.coAdjustmentCents
      acc.adjustedBudgetCents += row.adjustedBudgetCents
      acc.committedCents += row.committedCents
      acc.committedBilledCents += row.committedBilledCents
      acc.remainingCommitmentCents += row.remainingCommitmentCents
      acc.pendingCostCents += row.pendingCostCents
      acc.exposureCents += row.exposureCents
      acc.actualCents += row.actualCents
      acc.costToCompleteCents += row.costToCompleteCents
      acc.eacCents += row.eacCents
      acc.varianceAtCompletionCents += row.varianceAtCompletionCents
      acc.remainingToBuyCents += Math.max(0, row.adjustedBudgetCents - row.committedCents)
      acc.leftToSpendCents += row.adjustedBudgetCents - row.actualCents
      return acc
    },
    {
      budgetCents: 0,
      baselineCents: 0,
      coAdjustmentCents: 0,
      adjustedBudgetCents: 0,
      committedCents: 0,
      committedBilledCents: 0,
      remainingCommitmentCents: 0,
      pendingCostCents: 0,
      exposureCents: 0,
      actualCents: 0,
      costToCompleteCents: 0,
      eacCents: 0,
      varianceAtCompletionCents: 0,
      remainingToBuyCents: 0,
      leftToSpendCents: 0,
    },
  )
}

export function BudgetTable({
  rows,
  costCodesEnabled,
  isDetailed,
  hasCostTypes,
  editable,
  onOpenBucket,
  onEditAmount,
  onCreateCommitment,
  onStartBidPackage,
  emptyState,
}: {
  rows: UnifiedBudgetRow[]
  costCodesEnabled: boolean
  isDetailed: boolean
  hasCostTypes: boolean
  editable: boolean
  onOpenBucket: (key: string) => void
  onEditAmount: (lineId: string, amountDollars: string) => void
  onCreateCommitment: (row: UnifiedBudgetRow) => void
  onStartBidPackage: (row: UnifiedBudgetRow) => void
  emptyState: ReactNode
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Column count for the empty-state colSpan: code? + name + budget + committed + exposure +
  // spent + (simple: left,%spent | detailed: original,co,ctc,eac,vac,%comp) + actions.
  const tableColCount =
    (costCodesEnabled ? 1 : 0) + 5 + (isDetailed ? 6 : 2) + 1 + (isDetailed && hasCostTypes ? 1 : 0)

  // Commercial-style division grouping: group by cost-code category with
  // collapsible subtotal headers, but only when categories actually exist.
  const groups = useMemo(() => {
    const grouped = costCodesEnabled && rows.some((row) => row.category)
    if (!grouped) return null
    const map = new Map<string, UnifiedBudgetRow[]>()
    for (const row of rows) {
      const key = row.category?.trim() || "Other"
      const list = map.get(key) ?? []
      list.push(row)
      map.set(key, list)
    }
    return Array.from(map.entries()).map(([name, groupRows]) => ({
      name,
      rows: groupRows,
      totals: sumBudgetRows(groupRows),
    }))
  }, [costCodesEnabled, rows])

  const toggleGroup = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const columnTotals = useMemo(() => sumBudgetRows(rows), [rows])

  const renderMoneyCells = (totals: ColumnTotals, muted = false) => (
    <>
      {isDetailed && (
        <>
          <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
            {formatCurrency(totals.baselineCents)}
          </TableCell>
          <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
            {formatCurrency(totals.coAdjustmentCents)}
          </TableCell>
        </>
      )}
      <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
        {formatCurrency(totals.adjustedBudgetCents)}
      </TableCell>
      <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
        {formatCurrency(totals.committedCents)}
      </TableCell>
      <TableCell className="px-4 text-right text-sm tabular-nums">
        <span className={cn(totals.exposureCents > totals.adjustedBudgetCents ? "text-destructive" : muted ? "text-muted-foreground" : "")}>
          {formatCurrency(totals.exposureCents)}
        </span>
      </TableCell>
      <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
        {formatCurrency(totals.actualCents)}
      </TableCell>
      {isDetailed ? (
        <>
          <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
            {formatCurrency(totals.costToCompleteCents)}
          </TableCell>
          <TableCell className={cn("px-4 text-right text-sm tabular-nums", muted && "text-muted-foreground")}>
            {formatCurrency(totals.eacCents)}
          </TableCell>
          <TableCell className="px-4 text-right text-sm tabular-nums">
            <span className={cn(totals.varianceAtCompletionCents < 0 ? "text-destructive" : muted ? "text-muted-foreground" : "")}>
              {formatCurrency(totals.varianceAtCompletionCents)}
            </span>
          </TableCell>
          <TableCell className="px-4" />
        </>
      ) : (
        <>
          <TableCell className="px-4 text-right text-sm tabular-nums">
            <span className={cn(totals.leftToSpendCents < 0 ? "text-destructive" : muted ? "text-muted-foreground" : "")}>
              {formatCurrency(totals.leftToSpendCents)}
            </span>
          </TableCell>
          <TableCell className="px-4 text-right text-sm tabular-nums text-muted-foreground">
            {totals.adjustedBudgetCents > 0
              ? `${Math.round((totals.actualCents / totals.adjustedBudgetCents) * 100)}%`
              : "—"}
          </TableCell>
        </>
      )}
      <TableCell className="px-2" />
    </>
  )

  const renderRow = (row: UnifiedBudgetRow) => {
    const leftToSpend = row.adjustedBudgetCents - row.actualCents
    const inlineEditable = editable && row.lines.length === 1 && row.coAdjustmentCents === 0
    const openBucket = () => onOpenBucket(row.key)
    return (
      <TableRow
        key={row.key}
        className="group h-[60px] cursor-pointer hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none"
        onClick={openBucket}
        tabIndex={0}
        role="button"
        aria-label={`Open ${row.name}`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            openBucket()
          }
        }}
      >
        {costCodesEnabled && (
          <TableCell className="px-4">
            <div className="flex items-center gap-2">
              <StatusDot status={row.status} />
              <span className="bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">
                {row.code ?? "Uncoded"}
              </span>
            </div>
          </TableCell>
        )}
        <TableCell className="min-w-0 px-4">
          <div className="flex items-center gap-2">
            {!costCodesEnabled && <StatusDot status={row.status} className="shrink-0" />}
            <span className="block truncate text-sm font-medium">{row.name}</span>
          </div>
          {row.lines.length > 0 && (costCodesEnabled || row.lines.length > 1) && (
            <span className="block truncate text-xs text-muted-foreground">
              {row.lines.length === 1
                ? row.lines[0].description
                : `${row.lines.length} budget lines`}
            </span>
          )}
          <span
            className={cn(
              "mt-1 inline-flex border px-1.5 py-0.5 text-[11px] font-medium",
              buyoutClassName(row.buyout),
            )}
          >
            {formatBuyoutLabel(row.buyout)}
            {row.buyout?.lowest_bid_cents != null && row.buyout.open_count > 0
              ? ` · low ${formatCurrency(row.buyout.lowest_bid_cents, { compact: true })}`
              : ""}
          </span>
        </TableCell>
        {isDetailed && hasCostTypes && (
          <TableCell className="px-4 text-xs text-muted-foreground">
            {row.costType ? COST_TYPE_LABELS[row.costType] : "—"}
          </TableCell>
        )}
        {isDetailed && (
          <>
            <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
              <span className="text-sm">{formatCurrency(row.baselineCents ?? row.budgetCents)}</span>
            </TableCell>
            <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
              <span className="text-sm">{formatCurrency(row.coAdjustmentCents)}</span>
            </TableCell>
          </>
        )}
        <TableCell className="px-4 text-right tabular-nums">
          <InlineBudgetAmount
            cents={row.adjustedBudgetCents}
            editable={inlineEditable}
            onCommit={(amount) => onEditAmount(row.lines[0].id, amount)}
          />
        </TableCell>
        <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
          <span className="text-sm">{formatCurrency(row.committedCents)}</span>
          {row.committedCents > 0 && (
            <span className={cn("block text-[11px]", row.remainingCommitmentCents < 0 ? "text-destructive" : "text-muted-foreground")}>
              {formatCurrency(row.committedBilledCents, { compact: true })} billed
            </span>
          )}
        </TableCell>
        <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
          <span className={cn("text-sm", row.exposureCents > row.adjustedBudgetCents ? "text-destructive" : "")}>
            {formatCurrency(row.exposureCents)}
          </span>
          {row.pendingCostCents > 0 && (
            <span className="block text-[11px] text-muted-foreground">
              +{formatCurrency(row.pendingCostCents, { compact: true })} pending
            </span>
          )}
        </TableCell>
        <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
          <span className="text-sm">{formatCurrency(row.actualCents)}</span>
        </TableCell>
        {isDetailed ? (
          <>
            <TableCell className="px-4 text-right tabular-nums">
              <span className="text-sm text-muted-foreground">{formatCurrency(row.costToCompleteCents)}</span>
            </TableCell>
            <TableCell className="px-4 text-right tabular-nums">
              <span className="text-sm font-medium">{formatCurrency(row.eacCents)}</span>
            </TableCell>
            <TableCell className="px-4 text-right tabular-nums">
              <span className={cn("text-sm", row.varianceAtCompletionCents < 0 ? "text-destructive" : "text-muted-foreground")}>
                {formatCurrency(row.varianceAtCompletionCents)}
              </span>
            </TableCell>
            <TableCell className="px-4 text-right tabular-nums">
              <span className="text-sm text-muted-foreground">
                {row.percentComplete != null ? `${row.percentComplete}%` : "—"}
              </span>
            </TableCell>
          </>
        ) : (
          <>
            <TableCell className="px-4 text-right tabular-nums">
              <span className={cn("text-sm font-medium", leftToSpend < 0 ? "text-destructive" : "")}>
                {formatCurrency(leftToSpend)}
              </span>
            </TableCell>
            <TableCell className="px-4 text-right tabular-nums">
              <span
                className={cn(
                  "text-sm",
                  row.status === "over"
                    ? "text-destructive"
                    : row.status === "warning"
                      ? "text-warning"
                      : "text-muted-foreground",
                )}
              >
                {row.variancePercent}%
              </span>
            </TableCell>
          </>
        )}
        <TableCell className="px-2" onClick={(event) => event.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                aria-label="Row actions"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onOpenBucket(row.key)}>
                Open details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCreateCommitment(row)}>
                New commitment
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onStartBidPackage(row)}>
                Start bid package
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
    )
  }

  return (
    <div className="hidden border-t md:block overflow-x-auto">
      <Table className="w-full min-w-[820px]">
        <TableHeader>
          <TableRow className="border-b bg-muted/30 hover:bg-muted/30">
            {costCodesEnabled && (
              <TableHead className="w-[120px] px-4 text-xs uppercase tracking-wide">Code</TableHead>
            )}
            <TableHead className="min-w-[200px] px-4 text-xs uppercase tracking-wide">
              {costCodesEnabled ? "Scope" : "Budget line"}
            </TableHead>
            {isDetailed && hasCostTypes && (
              <TableHead className="w-[120px] px-4 text-xs uppercase tracking-wide">Cost type</TableHead>
            )}
            {isDetailed && (
              <>
                <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">Original</TableHead>
                <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">Approved CO</TableHead>
              </>
            )}
            <TableHead className="w-[120px] px-4 text-right text-xs uppercase tracking-wide">
              {isDetailed ? "Revised" : "Budget"}
            </TableHead>
            <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">
              <Hint className="justify-end" label="Committed" hint="Committed — amount locked in via approved subcontracts and purchase orders for this line." />
            </TableHead>
            <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">
              <Hint className="justify-end" label="Exposure" hint="Exposure — approved actual cost plus pending bills and sent commitment change orders." />
            </TableHead>
            <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">
              <Hint className="justify-end" label={isDetailed ? "Actual" : "Spent"} hint="Costs already incurred — approved bills, expenses, and labor on this line." />
            </TableHead>
            {isDetailed ? (
              <>
                <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">
                  <Hint className="justify-end" label="CTC" hint="Cost to Complete — estimated remaining cost to finish this line (EAC minus Actual)." />
                </TableHead>
                <TableHead className="w-[120px] px-4 text-right text-xs uppercase tracking-wide">
                  <Hint className="justify-end" label="EAC" hint="Estimate at Completion — projected total cost for this line when finished." />
                </TableHead>
                <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">
                  <Hint className="justify-end" label="VAC" hint="Variance at Completion — revised budget minus EAC. Negative means a projected overrun." />
                </TableHead>
                <TableHead className="w-[100px] px-4 text-right text-xs uppercase tracking-wide">% Comp</TableHead>
              </>
            ) : (
              <>
                <TableHead className="w-[120px] px-4 text-right text-xs uppercase tracking-wide">
                  <Hint className="justify-end" label="Left" hint="Left to spend — revised budget minus what you've spent so far." />
                </TableHead>
                <TableHead className="w-[90px] px-4 text-right text-xs uppercase tracking-wide">% spent</TableHead>
              </>
            )}
            <TableHead className="w-[56px] px-2" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={tableColCount} className="h-56 text-center hover:bg-transparent">
                {emptyState}
              </TableCell>
            </TableRow>
          ) : groups ? (
            groups.map((group) => {
              const collapsed = collapsedGroups.has(group.name)
              return [
                <TableRow
                  key={`group-${group.name}`}
                  className="cursor-pointer border-t bg-muted/40 hover:bg-muted/50"
                  onClick={() => toggleGroup(group.name)}
                  tabIndex={0}
                  role="button"
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? "Expand" : "Collapse"} ${group.name}`}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleGroup(group.name)
                    }
                  }}
                >
                  <TableCell
                    colSpan={(costCodesEnabled ? 1 : 0) + 1 + (isDetailed && hasCostTypes ? 1 : 0)}
                    className="px-4 py-2"
                  >
                    <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      {group.name}
                      <span className="font-normal normal-case tracking-normal">
                        · {group.rows.length} {group.rows.length === 1 ? "line" : "lines"}
                      </span>
                    </span>
                  </TableCell>
                  {renderMoneyCells(group.totals, true)}
                </TableRow>,
                ...(collapsed ? [] : group.rows.map(renderRow)),
              ]
            })
          ) : (
            rows.map(renderRow)
          )}
          {rows.length > 0 && (
            <TableRow className="border-t-2 bg-muted/20 font-medium hover:bg-muted/20">
              <TableCell
                colSpan={(costCodesEnabled ? 1 : 0) + 1 + (isDetailed && hasCostTypes ? 1 : 0)}
                className="px-4 text-xs uppercase tracking-wide text-muted-foreground"
              >
                Total · {rows.length} {rows.length === 1 ? "line" : "lines"}
              </TableCell>
              {renderMoneyCells(columnTotals)}
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

export function BudgetMobileCards({
  rows,
  costCodesEnabled,
  onOpenBucket,
  emptyState,
}: {
  rows: UnifiedBudgetRow[]
  costCodesEnabled: boolean
  onOpenBucket: (key: string) => void
  emptyState: ReactNode
}) {
  return (
    <div className="border-t md:hidden">
      {rows.length === 0 ? (
        <div className="px-4 py-12">{emptyState}</div>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const rowRemainingToBuy = Math.max(0, row.adjustedBudgetCents - row.committedCents)
            const rowToneClass =
              row.status === "over"
                ? "text-destructive"
                : row.status === "warning"
                  ? "text-warning"
                  : ""
            const rowPct =
              row.adjustedBudgetCents > 0
                ? Math.min(100, (row.actualCents / row.adjustedBudgetCents) * 100)
                : 0
            const rowCommittedPct =
              row.adjustedBudgetCents > 0
                ? Math.min(100, (row.committedCents / row.adjustedBudgetCents) * 100)
                : 0
            return (
              <li key={row.key}>
                <button
                  type="button"
                  onClick={() => onOpenBucket(row.key)}
                  className="block w-full px-4 py-4 text-left transition-colors hover:bg-muted/40 active:bg-muted"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        {costCodesEnabled && (
                          <span className="bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">
                            {row.code ?? "Uncoded"}
                          </span>
                        )}
                        {row.status === "over" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                        )}
                        {row.status === "warning" && (
                          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                        )}
                        {!costCodesEnabled && (
                          <span className="line-clamp-1 text-sm font-medium">{row.name}</span>
                        )}
                      </div>
                      {costCodesEnabled && (
                        <p className="mt-1.5 line-clamp-1 text-sm font-medium">{row.name}</p>
                      )}
                      {row.assignedCompanies.length > 0 && (
                        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                          {row.assignedCompanies.join(", ")}
                        </p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums">
                        {formatCurrency(row.adjustedBudgetCents, { compact: true })}
                      </p>
                      <p className={cn("text-[11px] tabular-nums", rowToneClass || "text-muted-foreground")}>
                        {row.variancePercent}% spent
                      </p>
                    </div>
                  </div>
                  <div className="relative mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="absolute inset-y-0 left-0 bg-primary/35"
                      style={{ width: `${rowCommittedPct}%` }}
                    />
                    <div
                      className="absolute inset-y-0 left-0 bg-primary"
                      style={{ width: `${rowPct}%` }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                    <span>Committed {formatCurrency(row.committedCents, { compact: true })}</span>
                    <span>To buy {formatCurrency(rowRemainingToBuy, { compact: true })}</span>
                    <span>Actual {formatCurrency(row.actualCents, { compact: true })}</span>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
