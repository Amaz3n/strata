"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import type { CostCode } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"

import { createProjectBudgetAction, replaceProjectBudgetLinesAction, updateProjectBudgetStatusAction, duplicateProjectBudgetVersionAction, acknowledgeVarianceAlertAction, runVarianceScanAction } from "@/app/(app)/projects/[id]/budget/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

type EditableBudgetLine = {
  id: string
  cost_code_id: string | null
  description: string
  amount_dollars: string
}

function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function formatCurrency(cents?: number | null) {
  if (typeof cents !== "number") return "—"
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

function statusBadge(status?: string) {
  const normalized = (status ?? "draft").toLowerCase()
  if (normalized === "locked") return <Badge variant="secondary">Locked</Badge>
  if (normalized === "approved") return <Badge variant="outline">Approved</Badge>
  return <Badge variant="outline">Draft</Badge>
}

function toLineState(lines: any[] | undefined): EditableBudgetLine[] {
  return (lines ?? []).map((line) => ({
    id: line.id ?? crypto.randomUUID(),
    cost_code_id: line.cost_code_id ?? null,
    description: line.description ?? "",
    amount_dollars: typeof line.amount_cents === "number" ? String((line.amount_cents / 100).toFixed(2)) : "0",
  }))
}

export function ProjectBudgetClient({
  projectId,
  budgetData,
  costCodes,
  varianceAlerts,
}: {
  projectId: string
  budgetData: any | null
  costCodes: CostCode[]
  varianceAlerts: any[]
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const currentBudget = budgetData?.budget ?? null
  const summary = budgetData?.summary ?? null
  const editable = !currentBudget || (currentBudget.status ?? "draft") === "draft"

  const [lines, setLines] = useState<EditableBudgetLine[]>(() => (currentBudget ? toLineState(currentBudget.lines) : []))

  useEffect(() => {
    setLines(currentBudget ? toLineState(currentBudget.lines) : [])
  }, [currentBudget])

  const costCodeOptions = useMemo(() => {
    const sorted = [...(costCodes ?? [])].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? ""))
    return sorted
  }, [costCodes])

  const lineErrors = useMemo(() => {
    const errors = new Map<string, string>()
    for (const line of lines) {
      if (!line.description.trim()) {
        errors.set(line.id, "Description required")
        continue
      }
      const cents = dollarsToCents(line.amount_dollars)
      if (cents == null || cents < 0) {
        errors.set(line.id, "Invalid amount")
        continue
      }
    }
    return errors
  }, [lines])

  const totalCents = useMemo(() => {
    let sum = 0
    for (const line of lines) {
      const cents = dollarsToCents(line.amount_dollars)
      if (cents == null) continue
      sum += cents
    }
    return sum
  }, [lines])

  const canSave = editable && lines.length > 0 && lineErrors.size === 0 && !isPending

  const addLine = () => {
    setLines((prev) => [
      ...prev,
      { id: crypto.randomUUID(), cost_code_id: null, description: "", amount_dollars: "" },
    ])
  }

  const removeLine = (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id))
  }

  const save = () => {
    if (!editable) return
    if (lines.length === 0) {
      toast({ title: "Add at least one line item" })
      return
    }
    if (lineErrors.size > 0) {
      toast({ title: "Fix budget line errors", description: "Some lines are missing a description or have an invalid amount." })
      return
    }

    const payloadLines = lines.map((line) => ({
      cost_code_id: line.cost_code_id,
      description: line.description.trim(),
      amount_cents: dollarsToCents(line.amount_dollars) ?? 0,
    }))

    startTransition(async () => {
      try {
        if (!currentBudget) {
          await createProjectBudgetAction({ project_id: projectId, status: "draft", lines: payloadLines })
          toast({ title: "Budget created" })
        } else {
          await replaceProjectBudgetLinesAction(projectId, currentBudget.id, payloadLines)
          toast({ title: "Budget updated" })
        }
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to save budget", description: (error as Error).message })
      }
    })
  }

  const setStatus = (status: "draft" | "approved" | "locked") => {
    if (!currentBudget) return
    startTransition(async () => {
      try {
        await updateProjectBudgetStatusAction(projectId, currentBudget.id, status)
        toast({ title: "Budget updated", description: `Status set to ${status}.` })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to update budget status", description: (error as Error).message })
      }
    })
  }

  const newVersion = () => {
    if (!currentBudget) return
    startTransition(async () => {
      try {
        await duplicateProjectBudgetVersionAction(projectId, currentBudget.id)
        toast({ title: "New budget version created" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to create version", description: (error as Error).message })
      }
    })
  }

  const acknowledge = (alertId: string, status: "acknowledged" | "resolved") => {
    startTransition(async () => {
      try {
        await acknowledgeVarianceAlertAction(projectId, alertId, status)
        toast({ title: status === "resolved" ? "Alert resolved" : "Alert acknowledged" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to update alert", description: (error as Error).message })
      }
    })
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-base">Budget</CardTitle>
            <div className="text-sm text-muted-foreground">
              {currentBudget ? (
                <span className="inline-flex items-center gap-2">
                  <span>Version {currentBudget.version ?? "—"}</span>
                  {statusBadge(currentBudget.status)}
                </span>
              ) : (
                "No budget yet"
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {currentBudget && (
              <Button variant="outline" onClick={newVersion} disabled={isPending}>
                New version
              </Button>
            )}
            {currentBudget?.status === "draft" && (
              <Button onClick={() => setStatus("approved")} disabled={isPending || lines.length === 0 || lineErrors.size > 0}>
                Approve
              </Button>
            )}
            {currentBudget?.status === "approved" && (
              <Button variant="secondary" onClick={() => setStatus("locked")} disabled={isPending}>
                Lock
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {summary ? (
            <div className="grid gap-3 md:grid-cols-3">
              <SummaryStat label="Adjusted budget" value={formatCurrency(summary.adjusted_budget_cents)} />
              <SummaryStat label="Committed" value={formatCurrency(summary.total_committed_cents)} />
              <SummaryStat label="Actual" value={formatCurrency(summary.total_actual_cents)} />
              <SummaryStat label="Invoiced" value={formatCurrency(summary.total_invoiced_cents)} />
              <SummaryStat
                label="Variance"
                value={formatCurrency(summary.total_variance_cents)}
                tone={summary.variance_percent > 100 ? "destructive" : summary.variance_percent > 90 ? "warning" : "ok"}
                meta={`${summary.variance_percent}%`}
              />
              <SummaryStat label="Gross margin" value={`${summary.gross_margin_percent ?? 0}%`} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Create a budget to unlock variance tracking and forecasting.</p>
          )}

          <Separator />

          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-sm font-medium">Budget lines</p>
              <p className="text-xs text-muted-foreground">
                {editable ? "Draft budgets are editable. Lock to prevent changes." : "This budget is read-only. Create a new version to edit."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {editable && (
                <Button variant="outline" onClick={addLine} disabled={isPending}>
                  Add line
                </Button>
              )}
              {editable && (
                <Button onClick={save} disabled={!canSave}>
                  {currentBudget ? "Save changes" : "Create budget"}
                </Button>
              )}
            </div>
          </div>

          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="divide-x">
                  <TableHead className="px-4 py-3">Cost code</TableHead>
                  <TableHead className="px-4 py-3">Description</TableHead>
                  <TableHead className="w-36 px-4 py-3 text-right">Amount</TableHead>
                  <TableHead className="w-16 px-4 py-3 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => {
                  const error = lineErrors.get(line.id)
                  return (
                    <TableRow key={line.id} className="divide-x align-top">
                      <TableCell className="px-4 py-3">
                        <Select
                          value={line.cost_code_id ?? "__uncoded__"}
                          onValueChange={(value) => {
                            const next = value === "__uncoded__" ? null : value
                            setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, cost_code_id: next } : l)))
                          }}
                          disabled={!editable}
                        >
                          <SelectTrigger className="h-9">
                            <SelectValue placeholder="Uncoded" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__uncoded__">Uncoded</SelectItem>
                            {costCodeOptions.map((cc) => (
                              <SelectItem key={cc.id} value={cc.id}>
                                {cc.code ? `${cc.code} — ${cc.name}` : cc.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <div className="space-y-1">
                          <Input
                            value={line.description}
                            onChange={(e) => setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, description: e.target.value } : l)))}
                            className={cn("h-9", error && "border-destructive")}
                            placeholder="e.g., Rough plumbing"
                            disabled={!editable}
                          />
                          {error && <p className="text-xs text-destructive">{error}</p>}
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <Input
                          value={line.amount_dollars}
                          onChange={(e) => setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, amount_dollars: e.target.value } : l)))}
                          className={cn("h-9 text-right", error && "border-destructive")}
                          inputMode="decimal"
                          placeholder="0.00"
                          disabled={!editable}
                        />
                      </TableCell>
                      <TableCell className="px-4 py-3 text-right">
                        {editable ? (
                          <Button variant="ghost" size="sm" onClick={() => removeLine(line.id)} disabled={isPending}>
                            Remove
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  )
                })}
                {lines.length === 0 && (
                  <TableRow className="divide-x">
                    <TableCell colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                      No budget lines yet.
                    </TableCell>
                  </TableRow>
                )}
                {lines.length > 0 && (
                  <TableRow className="divide-x bg-muted/40 font-medium">
                    <TableCell className="px-4 py-3" />
                    <TableCell className="px-4 py-3 text-right text-muted-foreground">Total</TableCell>
                    <TableCell className="px-4 py-3 text-right">{formatCurrency(totalCents)}</TableCell>
                    <TableCell className="px-4 py-3" />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle className="text-base">Variance alerts</CardTitle>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending || !currentBudget}
            onClick={() => {
              startTransition(async () => {
                try {
                  await runVarianceScanAction(projectId)
                  toast({ title: "Variance scan complete" })
                  router.refresh()
                } catch (error) {
                  toast({ title: "Unable to run variance scan", description: (error as Error).message })
                }
              })
            }}
          >
            Run scan
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {(varianceAlerts ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No alerts yet.</p>
          ) : (
            <div className="space-y-2">
              {(varianceAlerts ?? []).map((alert: any) => (
                <div key={alert.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">{alert.alert_type?.replaceAll("_", " ") ?? "alert"}</p>
                      <Badge variant={alert.status === "active" ? "destructive" : "outline"} className="capitalize">
                        {alert.status ?? "active"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {typeof alert.current_percent === "number" ? `${alert.current_percent}%` : "—"} · Budget{" "}
                      {formatCurrency(alert.budget_cents)} · Actual {formatCurrency(alert.actual_cents)}
                    </p>
                  </div>
                  {alert.status === "active" ? (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" disabled={isPending} onClick={() => acknowledge(alert.id, "acknowledged")}>
                        Acknowledge
                      </Button>
                      <Button variant="secondary" size="sm" disabled={isPending} onClick={() => acknowledge(alert.id, "resolved")}>
                        Resolve
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function SummaryStat({
  label,
  value,
  meta,
  tone,
}: {
  label: string
  value: string
  meta?: string
  tone?: "ok" | "warning" | "destructive"
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex items-baseline justify-between gap-2">
        <p className={cn("text-sm font-semibold truncate", tone === "destructive" && "text-destructive")}>{value}</p>
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
      </div>
    </div>
  )
}
