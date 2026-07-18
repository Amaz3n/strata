"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import type { BidScopeItem, BidPackage } from "@/lib/services/bids"
import type { BidScopeItemType } from "@/lib/validation/bids"
import { saveBidScopeItemsAction } from "@/app/(app)/bids/actions"
import { unwrapAction } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ChevronDown, Plus, Trash2 } from "@/components/icons"
import { parseCurrencyToCents, type BidWorkbenchContext } from "@/components/bids/bid-workbench-helpers"

const TYPE_OPTIONS: Array<{ value: BidScopeItemType; label: string }> = [
  { value: "base", label: "Base" },
  { value: "alternate", label: "Alternate" },
  { value: "allowance", label: "Allowance" },
  { value: "unit_price", label: "Unit price" },
]

interface ScopeRow {
  key: string
  id: string | null
  item_type: BidScopeItemType
  description: string
  details: string
  quantity: string
  unit: string
  budget: string
}

function toRow(item: BidScopeItem): ScopeRow {
  return {
    key: item.id,
    id: item.id,
    item_type: item.item_type,
    description: item.description,
    details: item.details ?? "",
    quantity: item.quantity != null ? String(item.quantity) : "",
    unit: item.unit ?? "",
    budget: item.budget_cents != null ? String(item.budget_cents / 100) : "",
  }
}

let rowSeq = 0
function blankRow(): ScopeRow {
  rowSeq += 1
  return {
    key: `new-${rowSeq}`,
    id: null,
    item_type: "base",
    description: "",
    details: "",
    quantity: "",
    unit: "",
    budget: "",
  }
}

interface BidScopeSectionProps {
  context: BidWorkbenchContext
  bidPackage: BidPackage
  scopeItems: BidScopeItem[]
  locked: boolean
  onScopeItemsChanged: (items: BidScopeItem[]) => void
}

export function BidScopeSection({
  context,
  bidPackage,
  scopeItems,
  locked,
  onScopeItemsChanged,
}: BidScopeSectionProps) {
  const quoteMode = bidPackage.mode === "quote"
  const [rows, setRows] = useState<ScopeRow[]>(() => scopeItems.map(toRow))
  const [collapsed, setCollapsed] = useState(quoteMode)
  const [isSaving, startSaving] = useTransition()

  const baseline = useMemo(() => JSON.stringify(scopeItems.map(toRow).map(stripKey)), [scopeItems])
  const dirty = JSON.stringify(rows.map(stripKey)) !== baseline

  function update(key: string, patch: Partial<ScopeRow>) {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function move(key: string, direction: -1 | 1) {
    setRows((prev) => {
      const index = prev.findIndex((row) => row.key === key)
      const target = index + direction
      if (index < 0 || target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  function handleSave() {
    for (const row of rows) {
      if (!row.description.trim()) {
        toast.error("Every scope line needs a description")
        return
      }
    }
    startSaving(async () => {
      try {
        const payload = {
          bid_package_id: bidPackage.id,
          items: rows.map((row) => ({
            id: row.id ?? undefined,
            item_type: row.item_type,
            description: row.description.trim(),
            details: row.details.trim() || null,
            quantity: row.quantity.trim() ? Number(row.quantity) : null,
            unit: row.unit.trim() || null,
            budget_cents: row.budget.trim() ? parseCurrencyToCents(row.budget) : null,
          })),
        }
        const saved = unwrapAction(await saveBidScopeItemsAction({ ...context, bidPackageId: bidPackage.id }, payload))
        onScopeItemsChanged(saved)
        setRows(saved.map(toRow))
        toast.success("Scope saved")
      } catch (error) {
        toast.error("Failed to save scope", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-semibold"
            onClick={() => setCollapsed((value) => !value)}
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} />
            Scope
            <span className="text-xs font-normal text-muted-foreground">
              {rows.length} {rows.length === 1 ? "line" : "lines"}
            </span>
          </button>
          <p className="mt-0.5 pl-5 text-xs text-muted-foreground">
            {quoteMode
              ? "Optional in quote mode — vendors bid a single number."
              : "Line-item scope vendors price against, apples-to-apples."}
          </p>
        </div>
        {!collapsed && !locked ? (
          <Button size="sm" variant="outline" onClick={handleSave} disabled={!dirty || isSaving}>
            {isSaving ? "Saving…" : "Save scope"}
          </Button>
        ) : null}
      </div>

      {collapsed ? null : locked ? (
        <div className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          Scope is locked once the package is awarded.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">No scope lines yet.</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => setRows([blankRow()])}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add first line
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16 px-2 py-2">#</TableHead>
                <TableHead className="w-32 px-2 py-2">Type</TableHead>
                <TableHead className="px-2 py-2">Description</TableHead>
                <TableHead className="w-24 px-2 py-2 text-right">Qty</TableHead>
                <TableHead className="w-20 px-2 py-2">Unit</TableHead>
                {quoteMode ? null : <TableHead className="w-32 px-2 py-2 text-right">Budget</TableHead>}
                <TableHead className="w-16 px-2 py-2" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                <TableRow key={row.key}>
                  <TableCell className="px-2 py-1.5">
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={index === 0}
                        onClick={() => move(row.key, -1)}
                        aria-label="Move up"
                      >
                        <ChevronDown className="h-3.5 w-3.5 rotate-180" />
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        disabled={index === rows.length - 1}
                        onClick={() => move(row.key, 1)}
                        aria-label="Move down"
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <span className="ml-1 tabular-nums text-xs text-muted-foreground">{index + 1}</span>
                    </div>
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Select
                      value={row.item_type}
                      onValueChange={(value) => update(row.key, { item_type: value as BidScopeItemType })}
                    >
                      <SelectTrigger className="h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TYPE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Input
                      className="h-8"
                      value={row.description}
                      onChange={(event) => update(row.key, { description: event.target.value })}
                      placeholder="Scope description"
                    />
                    <Input
                      className="mt-1 h-7 text-xs"
                      value={row.details}
                      onChange={(event) => update(row.key, { details: event.target.value })}
                      placeholder="Details (optional)"
                    />
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Input
                      className="h-8 text-right tabular-nums"
                      value={row.quantity}
                      inputMode="decimal"
                      onChange={(event) => update(row.key, { quantity: event.target.value })}
                    />
                  </TableCell>
                  <TableCell className="px-2 py-1.5">
                    <Input
                      className="h-8"
                      value={row.unit}
                      onChange={(event) => update(row.key, { unit: event.target.value })}
                      placeholder="ea"
                    />
                  </TableCell>
                  {quoteMode ? null : (
                    <TableCell className="px-2 py-1.5">
                      <Input
                        className="h-8 text-right tabular-nums"
                        value={row.budget}
                        inputMode="decimal"
                        onChange={(event) => update(row.key, { budget: event.target.value })}
                        placeholder="$0"
                      />
                    </TableCell>
                  )}
                  <TableCell className="px-2 py-1.5 text-right">
                    <button
                      type="button"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => setRows((prev) => prev.filter((item) => item.key !== row.key))}
                      aria-label="Remove line"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-2 py-2">
            <Button size="sm" variant="ghost" onClick={() => setRows((prev) => [...prev, blankRow()])}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add line
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function stripKey(row: ScopeRow) {
  const { key: _key, ...rest } = row
  return rest
}
