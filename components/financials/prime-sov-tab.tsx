"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, Download, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  importPrimeSovFromBudgetAction,
  importPrimeSovFromEstimateAction,
  savePrimeSovLinesAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import type { PrimeSovLine, PrimeSovState } from "@/lib/services/prime-sov"
import type { CostCode } from "@/lib/types"
import type { PrimeSovLineInput } from "@/lib/validation/pay-applications"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"

const NO_COST_CODE = "__none__"

interface SovRowDraft {
  key: string
  id?: string
  description: string
  cost_code_id: string | null
  scheduled_value: string
  retainage_override: string
  previous_billed_cents: number
  stored_materials_cents: number
  retainage_held_cents: number
  hasBilling: boolean
}

interface PrimeSovTabProps {
  projectId: string
  sov: PrimeSovState
  costCodes?: CostCode[]
  costCodesEnabled?: boolean
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function centsFromField(value: string): number | null {
  if (value.trim() === "") return 0
  const amount = Number(value.replace(/[$,\s]/g, ""))
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function rowFromLine(line: PrimeSovLine): SovRowDraft {
  return {
    key: line.id,
    id: line.id,
    description: line.description,
    cost_code_id: line.cost_code_id,
    scheduled_value: (line.scheduled_value_cents / 100).toFixed(2),
    retainage_override: line.retainage_percent_override != null ? String(line.retainage_percent_override) : "",
    previous_billed_cents: line.previous_billed_cents,
    stored_materials_cents: line.stored_materials_cents,
    retainage_held_cents: line.retainage_held_cents,
    hasBilling: line.previous_billed_cents !== 0 || line.stored_materials_cents !== 0 || line.retainage_held_cents !== 0,
  }
}

export function PrimeSovTab({ projectId, sov, costCodes = [], costCodesEnabled = true }: PrimeSovTabProps) {
  const router = useRouter()
  const [rows, setRows] = useState<SovRowDraft[]>(() => sov.lines.map(rowFromLine))
  const [dirty, setDirty] = useState(false)
  const [isPending, startTransition] = useTransition()
  const summary = sov.summary

  const totals = useMemo(() => {
    let scheduled = 0
    for (const row of rows) {
      scheduled += centsFromField(row.scheduled_value) ?? 0
    }
    return {
      scheduled,
      billed: rows.reduce((sum, row) => sum + row.previous_billed_cents, 0),
      stored: rows.reduce((sum, row) => sum + row.stored_materials_cents, 0),
      held: rows.reduce((sum, row) => sum + row.retainage_held_cents, 0),
    }
  }, [rows])

  const contractSum = summary?.contract_sum_cents ?? 0
  const variance = totals.scheduled - contractSum

  function applyState(next: PrimeSovState) {
    setRows(next.lines.map(rowFromLine))
    setDirty(false)
  }

  function updateRow(key: string, patch: Partial<SovRowDraft>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))
    setDirty(true)
  }

  function addRow() {
    setRows((current) => [
      ...current,
      {
        key: `new-${current.length}-${Date.now()}`,
        description: "",
        cost_code_id: null,
        scheduled_value: "",
        retainage_override: "",
        previous_billed_cents: 0,
        stored_materials_cents: 0,
        retainage_held_cents: 0,
        hasBilling: false,
      },
    ])
    setDirty(true)
  }

  function removeRow(key: string) {
    setRows((current) => current.filter((row) => row.key !== key))
    setDirty(true)
  }

  function save() {
    const lines: PrimeSovLineInput[] = []
    for (const [index, row] of rows.entries()) {
      const scheduled = centsFromField(row.scheduled_value)
      if (!row.description.trim()) {
        toast.error(`Line ${index + 1} needs a description`)
        return
      }
      if (scheduled == null) {
        toast.error(`Line ${index + 1} has an invalid scheduled value`)
        return
      }
      const override = row.retainage_override.trim() === "" ? null : Number(row.retainage_override)
      if (override != null && (!Number.isFinite(override) || override < 0 || override > 100)) {
        toast.error(`Line ${index + 1} has an invalid retainage override`)
        return
      }
      lines.push({
        id: row.id,
        description: row.description.trim(),
        cost_code_id: row.cost_code_id,
        scheduled_value_cents: scheduled,
        retainage_percent_override: override,
      })
    }

    startTransition(async () => {
      try {
        const state = unwrapAction(await savePrimeSovLinesAction(projectId, { lines }))
        applyState(state)
        toast.success("Schedule of values saved")
        router.refresh()
      } catch (error) {
        toast.error("Unable to save schedule of values", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  function importFrom(source: "budget" | "estimate") {
    startTransition(async () => {
      try {
        const action = source === "budget" ? importPrimeSovFromBudgetAction : importPrimeSovFromEstimateAction
        const state = unwrapAction(await action(projectId))
        applyState(state)
        toast.success(source === "budget" ? "SOV built from budget" : "SOV built from estimate")
        router.refresh()
      } catch (error) {
        toast.error("Unable to import schedule of values", {
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  if (!summary) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="border border-dashed p-6 text-sm text-muted-foreground">
          Set up the billing contract in financial setup before building a schedule of values.
        </div>
      </div>
    )
  }

  const hasBilling = summary.has_billing

  return (
    <div className="space-y-4 p-4 sm:p-6 lg:p-8">
      {variance !== 0 ? (
        <div className="flex items-start gap-2 border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            Scheduled values total {formatMoney(totals.scheduled)} but the contract sum is {formatMoney(contractSum)}
            {" — "}
            <span className="font-mono">{variance > 0 ? "+" : ""}{formatMoney(variance)}</span> to reconcile before
            billing.
          </span>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {rows.length} line{rows.length === 1 ? "" : "s"} · Contract sum{" "}
          <span className="font-mono text-foreground">{formatMoney(contractSum)}</span>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={isPending || hasBilling}>
                <Download className="mr-1.5 h-4 w-4" />
                Import
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => importFrom("budget")}>From budget</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => importFrom("estimate")}>From estimate</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button type="button" variant="outline" size="sm" onClick={addRow} disabled={isPending}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add line
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={isPending || !dirty}>
            Save
          </Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No schedule of values yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Break the contract sum into billable line items. Import from the budget or estimate, or add lines by hand.
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => importFrom("budget")} disabled={isPending}>
              Import from budget
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => importFrom("estimate")} disabled={isPending}>
              Import from estimate
            </Button>
            <Button type="button" size="sm" onClick={addRow} disabled={isPending}>
              Add line
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto border">
          <Table className="min-w-[880px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 text-right">#</TableHead>
                <TableHead>Description</TableHead>
                {costCodesEnabled ? <TableHead className="w-44">Cost code</TableHead> : null}
                <TableHead className="w-32 text-right">Scheduled value</TableHead>
                <TableHead className="w-28 text-right">Billed to date</TableHead>
                <TableHead className="w-24 text-right">Stored</TableHead>
                <TableHead className="w-16 text-right">%</TableHead>
                <TableHead className="w-28 text-right">Retainage held</TableHead>
                <TableHead className="w-20 text-right">Ret. %</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const scheduled = centsFromField(row.scheduled_value) ?? 0
                const percent = scheduled > 0 ? Math.round((row.previous_billed_cents / scheduled) * 100) : 0
                return (
                  <TableRow key={row.key}>
                    <TableCell className="text-right font-mono text-xs text-muted-foreground">{index + 1}</TableCell>
                    <TableCell>
                      <Input
                        value={row.description}
                        onChange={(event) => updateRow(row.key, { description: event.target.value })}
                        className="h-7 border-transparent bg-transparent px-1 text-sm shadow-none focus-visible:border-input"
                        aria-label={`Line ${index + 1} description`}
                      />
                    </TableCell>
                    {costCodesEnabled ? (
                      <TableCell>
                        <Select
                          value={row.cost_code_id ?? NO_COST_CODE}
                          onValueChange={(value) =>
                            updateRow(row.key, { cost_code_id: value === NO_COST_CODE ? null : value })
                          }
                        >
                          <SelectTrigger className="h-7 border-transparent bg-transparent px-1 text-xs shadow-none">
                            <SelectValue placeholder="—" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_COST_CODE}>No cost code</SelectItem>
                            {costCodes.map((code) => (
                              <SelectItem key={code.id} value={code.id}>
                                {[code.code, code.name].filter(Boolean).join(" ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right">
                      <Input
                        value={row.scheduled_value}
                        onChange={(event) => updateRow(row.key, { scheduled_value: event.target.value })}
                        inputMode="decimal"
                        disabled={row.hasBilling}
                        className="h-7 border-transparent bg-transparent px-1 text-right font-mono text-sm tabular-nums shadow-none focus-visible:border-input"
                        aria-label={`Line ${index + 1} scheduled value`}
                      />
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {formatMoney(row.previous_billed_cents)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {formatMoney(row.stored_materials_cents)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {percent}%
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {formatMoney(row.retainage_held_cents)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Input
                        value={row.retainage_override}
                        onChange={(event) => updateRow(row.key, { retainage_override: event.target.value })}
                        inputMode="decimal"
                        placeholder="—"
                        className="h-7 border-transparent bg-transparent px-1 text-right font-mono text-xs tabular-nums shadow-none focus-visible:border-input"
                        aria-label={`Line ${index + 1} retainage override`}
                      />
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => removeRow(row.key)}
                        disabled={row.hasBilling || isPending}
                        aria-label={`Remove line ${index + 1}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell />
                <TableCell className="text-xs font-medium uppercase text-muted-foreground">Totals</TableCell>
                {costCodesEnabled ? <TableCell /> : null}
                <TableCell className="text-right font-mono text-sm font-medium tabular-nums">
                  {formatMoney(totals.scheduled)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{formatMoney(totals.billed)}</TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{formatMoney(totals.stored)}</TableCell>
                <TableCell />
                <TableCell className="text-right font-mono text-sm tabular-nums">{formatMoney(totals.held)}</TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </div>
  )
}
