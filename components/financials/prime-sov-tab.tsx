"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle, CheckCircle2, Download, Link2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  importPrimeSovFromBudgetAction,
  importPrimeSovFromEstimateAction,
  savePrimeSovLinesAction,
  fetchSovBudgetEvidenceAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { unwrapAction } from "@/lib/action-result"
import type { PrimeSovLine, PrimeSovState, SovBudgetEvidenceOption } from "@/lib/services/prime-sov"
import type { CostCode } from "@/lib/types"
import type { PrimeSovLineInput } from "@/lib/validation/pay-applications"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import Link from "next/link"
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
  budget_line_id: string | null
  budget_line_ids: string[]
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
    budget_line_id: line.budget_line_id,
    budget_line_ids: line.budget_line_ids ?? (line.budget_line_id ? [line.budget_line_id] : []),
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
  const [revision, setRevision] = useState(sov.summary?.revision ?? 0)
  const [dirty, setDirty] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [mappingRow, setMappingRow] = useState<string | null>(null)
  const [mappingIds, setMappingIds] = useState<string[]>([])
  const [budgetEvidence, setBudgetEvidence] = useState<SovBudgetEvidenceOption[] | null>(null)
  const [mappingLoading, setMappingLoading] = useState(false)
  const [mappingError, setMappingError] = useState<string | null>(null)
  async function openMapping(row: SovRowDraft) {
    setMappingRow(row.key)
    setMappingIds(row.budget_line_ids)
    setMappingError(null)
    if (budgetEvidence) return
    setMappingLoading(true)
    try { setBudgetEvidence(unwrapAction(await fetchSovBudgetEvidenceAction(projectId))) }
    catch (error) { setMappingError(error instanceof Error ? error.message : "Unable to load budget evidence") }
    finally { setMappingLoading(false) }
  }
  const selectedEvidence = (budgetEvidence ?? []).filter((option) => mappingIds.includes(option.id))
  // Cost-code-enabled budgets share actuals/forecast across rows in the same code.
  const evidenceGroups = [...new Map(selectedEvidence.map((option) => [option.group_key, option])).values()]
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
    setRevision(next.summary?.revision ?? 0)
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
        budget_line_id: null,
        budget_line_ids: [],
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
        budget_line_id: row.budget_line_ids[0] ?? null,
        budget_line_ids: row.budget_line_ids,
        scheduled_value_cents: scheduled,
        retainage_percent_override: override,
      })
    }

    startTransition(async () => {
      try {
        const state = unwrapAction(await savePrimeSovLinesAction(projectId, { lines, expected_revision: revision }))
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
        toast.success(source === "budget" ? "Contract value allocated across budget scope — review before billing" : "Contract value allocated across estimate selling prices — review before billing")
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
      <Dialog open={mappingRow !== null} onOpenChange={(open) => { if (!open) setMappingRow(null) }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Link budget scope</DialogTitle>
            <DialogDescription>Connect this billing line to its cost evidence. These links do not change the owner’s scheduled value or certify progress.</DialogDescription>
          </DialogHeader>
          {mappingLoading ? <p className="text-sm text-muted-foreground">Loading budget evidence…</p> : mappingError ? (
            <p role="alert" className="text-sm text-destructive">{mappingError}</p>
          ) : budgetEvidence?.length ? (
            <>
              <div className="max-h-72 overflow-auto border divide-y">
                {budgetEvidence.map((option) => (
                  <label key={option.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                    <Checkbox checked={mappingIds.includes(option.id)} onCheckedChange={(checked) => setMappingIds((current) => checked ? [...current, option.id] : current.filter((id) => id !== option.id))} />
                    <span className="min-w-0 flex-1">{option.description}</span>
                    <span className="font-mono text-xs tabular-nums">{formatMoney(option.budget_cents)}</span>
                  </label>
                ))}
              </div>
              <dl className="grid grid-cols-3 gap-3 text-xs">
                {[
                  ["Actual cost", evidenceGroups.reduce((sum, option) => sum + option.actual_cents, 0)],
                  ["Committed", evidenceGroups.reduce((sum, option) => sum + option.committed_cents, 0)],
                  ["Forecast final cost", evidenceGroups.reduce((sum, option) => sum + option.forecast_cents, 0)],
                ].map(([label, value]) => <div key={String(label)}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-mono tabular-nums">{formatMoney(Number(value))}</dd></div>)}
              </dl>
              <p className="text-xs text-muted-foreground">Cost-code totals are counted once here. A shared bucket is supporting evidence; linking it to another billing line does not create additional cost.</p>
            </>
          ) : <p className="text-sm text-muted-foreground">Add budget scope before linking cost evidence.</p>}
          <DialogFooter>
            <Button variant="outline" asChild><Link href={`/projects/${projectId}/financials/budget`}>Open budget and sources</Link></Button>
            <Button disabled={mappingLoading || !!mappingError} onClick={() => {
              if (mappingRow) updateRow(mappingRow, { budget_line_ids: mappingIds, budget_line_id: mappingIds[0] ?? null })
              setMappingRow(null)
            }}>Apply links</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">Contract allocation</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <div>
              <span className="font-mono text-2xl font-semibold tracking-tight tabular-nums">{formatMoney(totals.scheduled)}</span>
              <span className="ml-2 text-sm text-muted-foreground">scheduled</span>
            </div>
            <div className="text-sm text-muted-foreground">
              of <span className="font-mono text-foreground tabular-nums">{formatMoney(contractSum)}</span>
            </div>
            {variance === 0 ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-success">
                <CheckCircle2 className="h-4 w-4" /> Balanced
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-warning">
                <AlertTriangle className="h-4 w-4" />
                {formatMoney(Math.abs(variance))} {variance > 0 ? "over" : "unallocated"}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {rows.length} owner-facing line{rows.length === 1 ? "" : "s"}. Cost codes and budget links remain supporting evidence.
          </p>
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
            {isPending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>

      {variance !== 0 ? (
        <div className="flex items-start gap-2 border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            Adjust scheduled values by <span className="font-mono font-medium tabular-nums">{formatMoney(Math.abs(variance))}</span> before preparing a pay application.
          </span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No schedule of values yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Break the owner contract into billable values. Estimate imports use selling prices; budget imports use cost proportions. Both allocate the full contract value for your review.
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
        <>
        <div className="hidden overflow-hidden border md:block">
          <Table className="table-fixed">
            <colgroup>
              <col className="w-11" />
              <col />
              <col className="w-40" />
              <col className="w-48" />
              <col className="w-44" />
              <col className="w-11" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right text-xs text-muted-foreground">#</TableHead>
                <TableHead>Billing scope</TableHead>
                <TableHead className="text-right">Scheduled value</TableHead>
                <TableHead className="text-right">Progress</TableHead>
                <TableHead className="text-right">Retainage</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => {
                const scheduled = centsFromField(row.scheduled_value) ?? 0
                const earned = row.previous_billed_cents + row.stored_materials_cents
                const percent = scheduled > 0 ? Math.round((earned / scheduled) * 100) : 0
                const remaining = Math.max(0, scheduled - earned)
                return (
                  <TableRow key={row.key} className="group align-top">
                    <TableCell className="pt-4 text-right font-mono text-xs text-muted-foreground">{index + 1}</TableCell>
                    <TableCell className="min-w-0 py-3 whitespace-normal">
                      <Input
                        value={row.description}
                        onChange={(event) => updateRow(row.key, { description: event.target.value })}
                        className="h-8 w-full min-w-0 border-transparent bg-transparent px-1 text-sm font-medium shadow-none focus-visible:border-input"
                        aria-label={`Line ${index + 1} description`}
                      />
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                      {costCodesEnabled ? (
                        <Select
                          value={row.cost_code_id ?? NO_COST_CODE}
                          onValueChange={(value) =>
                            updateRow(row.key, { cost_code_id: value === NO_COST_CODE ? null : value })
                          }
                        >
                          <SelectTrigger className="h-7 w-auto max-w-[15rem] border-0 bg-muted/55 px-2 text-xs text-muted-foreground shadow-none">
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
                      ) : null}
                      <Button type="button" variant="ghost" size="sm" className="h-7 max-w-full gap-1.5 px-2 text-xs font-normal text-muted-foreground" onClick={() => void openMapping(row)}>
                        <Link2 className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{row.budget_line_ids.length ? `${row.budget_line_ids.length} budget ${row.budget_line_ids.length === 1 ? "link" : "links"}` : "Link budget evidence"}</span>
                      </Button>
                      </div>
                    </TableCell>
                    <TableCell className="py-3 text-right align-top">
                      <div className="relative ml-auto w-36">
                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                        <Input
                          value={row.scheduled_value}
                          onChange={(event) => updateRow(row.key, { scheduled_value: event.target.value })}
                          inputMode="decimal"
                          disabled={row.hasBilling}
                          className="h-9 pl-6 text-right font-mono text-sm tabular-nums"
                          aria-label={`Line ${index + 1} scheduled value`}
                        />
                      </div>
                      {row.hasBilling ? <p className="mt-1 text-[11px] text-muted-foreground">Locked after billing</p> : null}
                    </TableCell>
                    <TableCell className="py-3 text-right align-top">
                      <p className="font-mono text-sm font-medium tabular-nums">{formatMoney(earned)}</p>
                      <div className="mt-1.5 ml-auto h-1 w-28 overflow-hidden bg-muted" aria-hidden="true"><div className="h-full bg-foreground/55" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} /></div>
                      <p className="mt-1 text-xs text-muted-foreground">{percent}% · {formatMoney(remaining)} remaining</p>
                      {row.stored_materials_cents ? <p className="mt-0.5 text-[11px] text-muted-foreground">Includes {formatMoney(row.stored_materials_cents)} stored</p> : null}
                    </TableCell>
                    <TableCell className="py-3 text-right align-top">
                      <p className="font-mono text-sm font-medium tabular-nums">{formatMoney(row.retainage_held_cents)}</p>
                      <div className="mt-1 flex items-center justify-end gap-1 text-xs text-muted-foreground">
                        <span>Rate</span>
                        <Input
                          value={row.retainage_override}
                          onChange={(event) => updateRow(row.key, { retainage_override: event.target.value })}
                          inputMode="decimal"
                          placeholder="Default"
                          className="h-7 w-20 px-2 text-right font-mono text-xs tabular-nums shadow-none"
                          aria-label={`Line ${index + 1} retainage override`}
                        />
                        {row.retainage_override ? <span>%</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="py-3 align-top">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
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
                <TableCell className="text-right font-mono text-sm font-medium tabular-nums">
                  {formatMoney(totals.scheduled)}
                </TableCell>
                <TableCell className="text-right">
                  <p className="font-mono text-sm tabular-nums">{formatMoney(totals.billed + totals.stored)}</p>
                  <p className="mt-0.5 text-xs font-normal text-muted-foreground">Completed + stored</p>
                </TableCell>
                <TableCell className="text-right font-mono text-sm tabular-nums">{formatMoney(totals.held)}</TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>
        </div>
        <div className="divide-y border md:hidden">
          {rows.map((row, index) => {
            const scheduled = centsFromField(row.scheduled_value) ?? 0
            const earned = row.previous_billed_cents + row.stored_materials_cents
            const percent = scheduled > 0 ? Math.round((earned / scheduled) * 100) : 0
            const remaining = Math.max(0, scheduled - earned)
            return <div key={row.key} className="space-y-3 p-4">
              <div className="flex items-start gap-2">
                <span className="mt-2 w-5 shrink-0 text-right font-mono text-xs text-muted-foreground">{index + 1}</span>
                <Input value={row.description} onChange={(event) => updateRow(row.key, { description: event.target.value })} className="h-9 min-w-0 flex-1 font-medium" aria-label={`Line ${index + 1} description`} />
                <Button type="button" variant="ghost" size="icon" className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeRow(row.key)} disabled={row.hasBilling || isPending} aria-label={`Remove line ${index + 1}`}><Trash2 className="h-4 w-4" /></Button>
              </div>
              <div className="ml-7 flex flex-wrap gap-2">
                {costCodesEnabled ? <Select value={row.cost_code_id ?? NO_COST_CODE} onValueChange={(value) => updateRow(row.key, { cost_code_id: value === NO_COST_CODE ? null : value })}><SelectTrigger className="h-8 w-auto max-w-full text-xs"><SelectValue placeholder="Cost code" /></SelectTrigger><SelectContent><SelectItem value={NO_COST_CODE}>No cost code</SelectItem>{costCodes.map((code) => <SelectItem key={code.id} value={code.id}>{[code.code, code.name].filter(Boolean).join(" ")}</SelectItem>)}</SelectContent></Select> : null}
                <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void openMapping(row)}><Link2 className="h-3.5 w-3.5" />{row.budget_line_ids.length ? `${row.budget_line_ids.length} budget ${row.budget_line_ids.length === 1 ? "link" : "links"}` : "Link budget"}</Button>
              </div>
              <div className="ml-7 grid grid-cols-2 gap-3">
                <div><p className="text-xs text-muted-foreground">Scheduled value</p><Input value={row.scheduled_value} onChange={(event) => updateRow(row.key, { scheduled_value: event.target.value })} inputMode="decimal" disabled={row.hasBilling} className="mt-1 h-9 text-right font-mono tabular-nums" aria-label={`Line ${index + 1} scheduled value`} /></div>
                <div><p className="text-xs text-muted-foreground">Completed + stored</p><p className="mt-2 font-mono text-sm font-medium tabular-nums">{formatMoney(earned)}</p><p className="text-xs text-muted-foreground">{percent}% · {formatMoney(remaining)} left</p></div>
                <div><p className="text-xs text-muted-foreground">Retainage held</p><p className="mt-2 font-mono text-sm font-medium tabular-nums">{formatMoney(row.retainage_held_cents)}</p></div>
                <div><p className="text-xs text-muted-foreground">Retainage rate</p><div className="mt-1 flex items-center gap-1"><Input value={row.retainage_override} onChange={(event) => updateRow(row.key, { retainage_override: event.target.value })} inputMode="decimal" placeholder="Default" className="h-9 text-right font-mono text-xs" aria-label={`Line ${index + 1} retainage override`} />{row.retainage_override ? <span className="text-xs text-muted-foreground">%</span> : null}</div></div>
              </div>
            </div>
          })}
        </div>
        </>
      )}
    </div>
  )
}
