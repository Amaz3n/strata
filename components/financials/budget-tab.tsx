"use client"

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  CheckCircle2,
  ListOrdered,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react"

import type { CostCode, Company } from "@/lib/types"
import type { CommitmentSummary, CommitmentLine } from "@/lib/services/commitments"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"

import {
  acknowledgeVarianceAlertAction,
  createProjectBudgetAction,
  duplicateProjectBudgetVersionAction,
  replaceProjectBudgetLinesAction,
  runVarianceScanAction,
  updateProjectBudgetStatusAction,
} from "@/app/(app)/projects/[id]/budget/actions"
import { fetchBudgetBucketCommitmentsAction } from "@/app/(app)/projects/[id]/financials/actions"
import {
  createCommitmentLineAction,
  createProjectCommitmentAction,
  deleteCommitmentLineAction,
  listCommitmentLinesAction,
  listCostCodesAction,
  updateCommitmentLineAction,
  updateProjectCommitmentAction,
} from "@/app/(app)/projects/[id]/commitments/actions"
import {
  attachFileAction,
  detachFileLinkAction,
  listAttachmentsAction,
  uploadFileAction,
} from "@/app/(app)/documents/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet"

type EditableBudgetLine = {
  id: string
  cost_code_id: string | null
  description: string
  amount_dollars: string
}

type CostBucketDraft = {
  key?: string | null
  costCodeId: string | null
  description: string
  amountDollars: string
  lineIds?: string[]
}

interface BudgetTabProps {
  projectId: string
  budgetData: any | null
  costCodes: CostCode[]
  varianceAlerts: any[]
  commitments: CommitmentSummary[]
  companies: Company[]
}

function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

function formatCurrency(cents?: number | null, opts?: { compact?: boolean }) {
  if (typeof cents !== "number") return "—"
  const dollars = cents / 100
  if (opts?.compact && Math.abs(dollars) >= 1000) {
    return dollars.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    })
  }
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function toLineState(lines: any[] | undefined): EditableBudgetLine[] {
  return (lines ?? []).map((line) => ({
    id: line.id ?? crypto.randomUUID(),
    cost_code_id: line.cost_code_id ?? null,
    description: line.description ?? "",
    amount_dollars:
      typeof line.amount_cents === "number"
        ? String((line.amount_cents / 100).toFixed(2))
        : "0",
  }))
}

function statusTone(status?: string): "draft" | "approved" | "locked" | "complete" | "canceled" {
  const n = (status ?? "draft").toLowerCase()
  if (n === "approved" || n === "locked" || n === "complete" || n === "canceled") return n as any
  return "draft"
}

function BudgetStatusBadge({ status }: { status?: string }) {
  const tone = statusTone(status)
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    approved: {
      label: "Approved",
      cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
    locked: { label: "Locked", cls: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
  }
  const entry = map[tone] ?? map.draft
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        entry.cls,
      )}
    >
      {entry.label}
    </span>
  )
}

function CommitmentStatusBadge({ status }: { status?: string }) {
  const tone = statusTone(status)
  const map: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "bg-muted text-muted-foreground" },
    approved: {
      label: "Approved",
      cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
    complete: { label: "Complete", cls: "bg-slate-500/10 text-slate-700 dark:text-slate-300" },
    canceled: {
      label: "Canceled",
      cls: "bg-destructive/10 text-destructive",
    },
  }
  const entry = map[tone] ?? map.draft
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        entry.cls,
      )}
    >
      {entry.label}
    </span>
  )
}

export function BudgetTab({
  projectId,
  budgetData,
  costCodes,
  varianceAlerts,
  commitments,
  companies,
}: BudgetTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const currentBudget = budgetData?.budget ?? null
  const summary = budgetData?.summary ?? null
  const editable = !currentBudget || (currentBudget.status ?? "draft") === "draft"

  const [lines, setLines] = useState<EditableBudgetLine[]>(() =>
    currentBudget ? toLineState(currentBudget.lines) : [],
  )
  const [budgetLineSearch, setBudgetLineSearch] = useState("")
  const [bucketEditorOpen, setBucketEditorOpen] = useState(false)
  const [editingBucketDraft, setEditingBucketDraft] = useState<CostBucketDraft | null>(null)
  const [activeBucketKey, setActiveBucketKey] = useState<string | null>(null)
  const [activeBucketCommitments, setActiveBucketCommitments] = useState<
    Array<CommitmentSummary & { allocated_cents: number; matching_line_count: number }>
  >([])
  const [activeBucketCommitmentsLoading, setActiveBucketCommitmentsLoading] = useState(false)

  useEffect(() => {
    setLines(currentBudget ? toLineState(currentBudget.lines) : [])
  }, [currentBudget])

  const costCodeOptions = useMemo(
    () => [...(costCodes ?? [])].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")),
    [costCodes],
  )

  const costCodeById = useMemo(() => {
    const map = new Map<string, CostCode>()
    for (const code of costCodes ?? []) {
      map.set(code.id, code)
    }
    return map
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
      }
    }
    return errors
  }, [lines])

  const totalLinesCents = useMemo(() => {
    let sum = 0
    for (const line of lines) {
      const cents = dollarsToCents(line.amount_dollars)
      if (cents == null) continue
      sum += cents
    }
    return sum
  }, [lines])

  const canSave = editable && lines.length > 0 && lineErrors.size === 0 && !isPending

  const openCreateBucket = () => {
    setEditingBucketDraft({
      costCodeId: null,
      description: "",
      amountDollars: "",
      lineIds: [],
    })
    setBucketEditorOpen(true)
  }

  const openEditBucket = (bucket: {
    key: string
    costCodeId: string | null
    lines: EditableBudgetLine[]
    budgetCents: number
  }) => {
    setEditingBucketDraft({
      key: bucket.key,
      costCodeId: bucket.costCodeId,
      description: bucket.lines.length === 1 ? bucket.lines[0]?.description ?? "" : bucket.lines[0]?.description ?? "",
      amountDollars: String(((bucket.budgetCents ?? 0) / 100).toFixed(2)),
      lineIds: bucket.lines.map((line) => line.id),
    })
    setBucketEditorOpen(true)
  }

  const upsertBucket = (draft: CostBucketDraft) => {
    const nextLine: EditableBudgetLine = {
      id: draft.lineIds?.[0] ?? crypto.randomUUID(),
      cost_code_id: draft.costCodeId,
      description: draft.description.trim(),
      amount_dollars: draft.amountDollars.trim() || "0",
    }

    setLines((prev) => {
      const removeIds = new Set(draft.lineIds ?? [])
      const filtered = prev.filter((line) => !removeIds.has(line.id))
      return [...filtered, nextLine]
    })
    setBucketEditorOpen(false)
    setEditingBucketDraft(null)
  }

  const removeBucket = (lineIds: string[]) => {
    const ids = new Set(lineIds)
    setLines((prev) => prev.filter((line) => !ids.has(line.id)))
  }

  const save = () => {
    if (!editable) return
    if (lines.length === 0) {
      toast({ title: "Add at least one cost bucket" })
      return
    }
    if (lineErrors.size > 0) {
      toast({
        title: "Fix cost bucket errors",
        description: "Some buckets are missing a scope note or have an invalid amount.",
      })
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
          await createProjectBudgetAction({
            project_id: projectId,
            status: "draft",
            lines: payloadLines,
          })
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
        toast({
          title: "Unable to update budget status",
          description: (error as Error).message,
        })
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

  const runScan = () =>
    startTransition(async () => {
      try {
        await runVarianceScanAction(projectId)
        toast({ title: "Variance scan complete" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to run variance scan", description: (error as Error).message })
      }
    })

  // ---------- Summary computations ----------
  const adjustedBudget = summary?.adjusted_budget_cents ?? totalLinesCents
  const committedTotal = summary?.total_committed_cents ?? 0
  const actualTotal = summary?.total_actual_cents ?? 0
  const invoicedTotal = summary?.total_invoiced_cents ?? 0
  const varianceCents = summary?.total_variance_cents ?? 0
  const variancePercent = summary?.variance_percent ?? 0
  const remaining = Math.max(0, adjustedBudget - actualTotal)

  const committedPct =
    adjustedBudget > 0 ? Math.min(100, (committedTotal / adjustedBudget) * 100) : 0
  const actualPct =
    adjustedBudget > 0 ? Math.min(100, (actualTotal / adjustedBudget) * 100) : 0

  const varianceTone: "ok" | "warning" | "danger" =
    variancePercent > 100 ? "danger" : variancePercent > 90 ? "warning" : "ok"

  const activeAlerts = (varianceAlerts ?? []).filter((a) => a.status === "active")

  // ---------- Commitments state ----------
  const companyOptions = useMemo(
    () => [...(companies ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [companies],
  )

  const [createOpen, setCreateOpen] = useState(false)
  const [editCommitment, setEditCommitment] = useState<CommitmentSummary | null>(null)
  const [linesCommitment, setLinesCommitment] = useState<CommitmentSummary | null>(null)
  const [filesCommitment, setFilesCommitment] = useState<CommitmentSummary | null>(null)

  const breakdownByCostCode = useMemo(() => {
    const map = new Map<string, any>()
    for (const row of budgetData?.breakdown ?? []) {
      map.set(row.cost_code_id ?? "uncoded", row)
    }
    return map
  }, [budgetData?.breakdown])

  const unifiedRows = useMemo(() => {
    const grouped = new Map<
      string,
      {
        key: string
        costCodeId: string | null
        code?: string
        name: string
        category?: string | null
        lines: EditableBudgetLine[]
        budgetCents: number
        committedCents: number
        actualCents: number
        invoicedCents: number
        varianceCents: number
        variancePercent: number
        status: string
      }
    >()

    for (const line of lines) {
      const key = line.cost_code_id ?? "uncoded"
      const code = line.cost_code_id ? costCodeById.get(line.cost_code_id) : null
      const breakdown = breakdownByCostCode.get(key)
      const existing = grouped.get(key) ?? {
        key,
        costCodeId: line.cost_code_id ?? null,
        code: code?.code,
        name: code?.name ?? "Uncoded",
        category: code?.category ?? null,
        lines: [] as EditableBudgetLine[],
        budgetCents: 0,
        committedCents: breakdown?.committed_cents ?? 0,
        actualCents: breakdown?.actual_cents ?? 0,
        invoicedCents: breakdown?.invoiced_cents ?? 0,
        varianceCents: breakdown?.variance_cents ?? 0,
        variancePercent: breakdown?.variance_percent ?? 0,
        status: breakdown?.status ?? "ok",
      }
      existing.lines.push(line)
      existing.budgetCents += dollarsToCents(line.amount_dollars) ?? 0
      grouped.set(key, existing)
    }

    for (const [key, breakdown] of breakdownByCostCode) {
      if (grouped.has(key)) continue
      const code = breakdown.cost_code_id ? costCodeById.get(breakdown.cost_code_id) : null
      grouped.set(key, {
        key,
        costCodeId: breakdown.cost_code_id ?? null,
        code: code?.code,
        name: code?.name ?? "Uncoded",
        category: code?.category ?? null,
        lines: [] as EditableBudgetLine[],
        budgetCents: breakdown.budget_cents ?? 0,
        committedCents: breakdown.committed_cents ?? 0,
        actualCents: breakdown.actual_cents ?? 0,
        invoicedCents: breakdown.invoiced_cents ?? 0,
        varianceCents: breakdown.variance_cents ?? 0,
        variancePercent: breakdown.variance_percent ?? 0,
        status: breakdown.status ?? "ok",
      })
    }

    return Array.from(grouped.values()).sort((a, b) => {
      const codeA = a.code ?? "zzz"
      const codeB = b.code ?? "zzz"
      return codeA.localeCompare(codeB) || a.name.localeCompare(b.name)
    })
  }, [breakdownByCostCode, costCodeById, lines])

  const filteredUnifiedRows = useMemo(() => {
    const term = budgetLineSearch.trim().toLowerCase()
    if (!term) return unifiedRows
    return unifiedRows.filter((row) =>
      [
        row.code,
        row.name,
        row.category,
        ...row.lines.map((line) => line.description),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term)),
    )
  }, [budgetLineSearch, unifiedRows])

  const activeBucket = unifiedRows.find((row) => row.key === activeBucketKey) ?? null

  useEffect(() => {
    if (!activeBucket) {
      setActiveBucketCommitments([])
      return
    }

    let cancelled = false
    setActiveBucketCommitmentsLoading(true)
    fetchBudgetBucketCommitmentsAction(projectId, activeBucket.costCodeId)
      .then((rows) => {
        if (!cancelled) {
          setActiveBucketCommitments(rows as Array<CommitmentSummary & { allocated_cents: number; matching_line_count: number }>)
        }
      })
      .catch(() => {
        if (!cancelled) setActiveBucketCommitments([])
      })
      .finally(() => {
        if (!cancelled) setActiveBucketCommitmentsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeBucket, projectId])

  // ---------- Render ----------
  return (
    <div className="space-y-6">
      {activeAlerts.length > 0 && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              {activeAlerts.length} active variance{" "}
              {activeAlerts.length === 1 ? "alert" : "alerts"}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={runScan}
              disabled={isPending || !currentBudget}
            >
              Run scan
            </Button>
          </div>
          <div className="space-y-1.5">
            {activeAlerts.slice(0, 3).map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-medium capitalize">
                    {alert.alert_type?.replaceAll("_", " ") ?? "Alert"}
                  </span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {typeof alert.current_percent === "number"
                      ? `${alert.current_percent}% of budget`
                      : ""}
                    {" · "}
                    {formatCurrency(alert.actual_cents)} of{" "}
                    {formatCurrency(alert.budget_cents)}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={isPending}
                    onClick={() => acknowledge(alert.id, "acknowledged")}
                  >
                    Ack
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={isPending}
                    onClick={() => acknowledge(alert.id, "resolved")}
                  >
                    Resolve
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Hero summary */}
      <div className="rounded-xl border bg-card p-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
              <span>Project budget</span>
              {currentBudget && (
                <>
                  <span aria-hidden>·</span>
                  <span>Version {currentBudget.version ?? "1"}</span>
                </>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">
                {formatCurrency(adjustedBudget)}
              </span>
              {currentBudget && <BudgetStatusBadge status={currentBudget.status} />}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {currentBudget
                ? editable
                  ? "Draft budget — edits below will be saved as this version."
                  : "This version is read-only. Create a new version to make changes."
                : "No budget yet. Add lines below and save to create one."}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {currentBudget && (
              <Button variant="outline" onClick={newVersion} disabled={isPending}>
                New version
              </Button>
            )}
            {currentBudget?.status === "draft" && (
              <Button
                onClick={() => setStatus("approved")}
                disabled={isPending || lines.length === 0 || lineErrors.size > 0}
              >
                <CheckCircle2 className="h-4 w-4" />
                Approve
              </Button>
            )}
            {currentBudget?.status === "approved" && (
              <Button variant="secondary" onClick={() => setStatus("locked")} disabled={isPending}>
                Lock
              </Button>
            )}
          </div>
        </div>

        {/* Utilization bar */}
        <div className="space-y-2">
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="absolute inset-y-0 left-0 bg-primary/40"
              style={{ width: `${committedPct}%` }}
            />
            <div
              className="absolute inset-y-0 left-0 bg-primary"
              style={{ width: `${actualPct}%` }}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-4">
              <LegendDot className="bg-primary" label={`Actual ${actualPct.toFixed(0)}%`} />
              <LegendDot
                className="bg-primary/40"
                label={`Committed ${committedPct.toFixed(0)}%`}
              />
              <LegendDot className="bg-muted-foreground/30" label="Remaining" />
            </div>
            <span className="tabular-nums">
              {formatCurrency(remaining)} remaining
            </span>
          </div>
        </div>

        {/* Stat grid */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <HeroStat label="Committed" value={formatCurrency(committedTotal)} />
          <HeroStat label="Actual" value={formatCurrency(actualTotal)} />
          <HeroStat label="Invoiced" value={formatCurrency(invoicedTotal)} />
          <HeroStat
            label="Variance"
            value={formatCurrency(varianceCents)}
            meta={summary ? `${variancePercent}%` : undefined}
            tone={varianceTone}
          />
        </div>
      </div>

      {/* Unified budget control table */}
      <section>
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">Cost plan</h3>
              <p className="text-xs text-muted-foreground">
                One table for budget buckets, committed costs, actual spend, and variance.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Input
                placeholder="Search cost codes, categories, or scope..."
                className="w-full sm:w-72"
                value={budgetLineSearch}
                onChange={(event) => setBudgetLineSearch(event.target.value)}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" className="self-end sm:self-auto">
                    <MoreHorizontal className="h-4 w-4" />
                    <span className="sr-only">Budget actions</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {editable && (
                    <DropdownMenuItem onClick={openCreateBucket}>
                      Add cost bucket
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => setCreateOpen(true)}
                    disabled={companyOptions.length === 0}
                  >
                    New commitment
                  </DropdownMenuItem>
                  {editable && (
                    <DropdownMenuItem onClick={save} disabled={!canSave}>
                      {currentBudget ? "Save changes" : "Create budget"}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="md:hidden">
            <div className="space-y-3 p-4">
              {filteredUnifiedRows.map((row) => {
                const budgetTone =
                  row.status === "over"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : row.status === "warning"
                      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                return (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => setActiveBucketKey(row.key)}
                    className="block w-full rounded-lg border bg-card p-4 text-left transition-colors hover:bg-muted/50 active:bg-muted"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="font-mono text-[10px] font-normal">
                            {row.code ?? "Uncoded"}
                          </Badge>
                          <Badge variant="secondary" className={cn("text-[10px] font-normal", budgetTone)}>
                            {row.variancePercent}% used
                          </Badge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm font-semibold">
                          {row.name}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {row.lines.length > 0
                            ? row.lines.length === 1
                              ? row.lines[0].description
                              : `${row.lines.length} budget lines`
                            : "No budget lines yet"}
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Row actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => {
                              setActiveBucketKey(row.key)
                            }}
                          >
                            Open details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                            New commitment
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                      <MobileMetric label="Budget" value={formatCurrency(row.budgetCents)} />
                      <MobileMetric label="Committed" value={formatCurrency(row.committedCents)} />
                      <MobileMetric label="Actual" value={formatCurrency(row.actualCents)} />
                      <MobileMetric
                        label="Variance"
                        value={formatCurrency(row.varianceCents)}
                        tone={row.status === "over" ? "danger" : row.status === "warning" ? "warning" : "ok"}
                      />
                    </div>
                  </button>
                )
              })}
              {filteredUnifiedRows.length === 0 && (
                <UnifiedBudgetEmptyState editable={editable} onCreate={openCreateBucket} />
              )}
            </div>
          </div>

          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[180px] px-4">Cost code</TableHead>
                  <TableHead className="min-w-[320px] px-4">Scope</TableHead>
                  <TableHead className="hidden lg:table-cell w-[150px] px-4 text-right">Budget</TableHead>
                  <TableHead className="hidden lg:table-cell w-[150px] px-4 text-right">Committed</TableHead>
                  <TableHead className="w-[150px] px-4 text-right">Actual</TableHead>
                  <TableHead className="w-[150px] px-4 text-right">Variance</TableHead>
                  <TableHead className="w-[72px] px-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUnifiedRows.map((row) => {
                  const toneClass =
                    row.status === "over"
                      ? "text-destructive"
                      : row.status === "warning"
                        ? "text-amber-600 dark:text-amber-400"
                        : ""
                  return (
                    <TableRow
                      key={row.key}
                      className="group h-[64px] cursor-pointer hover:bg-muted/30"
                      onClick={() => setActiveBucketKey(row.key)}
                    >
                      <TableCell className="px-4">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md bg-muted px-2 py-1 font-mono text-xs font-medium">
                            {row.code ?? "Uncoded"}
                          </span>
                          {row.status === "over" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-label="Over budget" />
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="min-w-0 px-4">
                        <span className="block truncate text-sm font-medium">
                          {row.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.lines.length > 0
                            ? row.lines.length === 1
                              ? row.lines[0].description
                              : `${row.lines.length} budget lines`
                            : "No budget lines yet"}
                        </span>
                      </TableCell>
                      <TableCell className="hidden px-4 text-right lg:table-cell">
                        <span className="text-sm font-semibold tabular-nums">
                          {formatCurrency(row.budgetCents)}
                        </span>
                      </TableCell>
                      <TableCell className="hidden px-4 text-right lg:table-cell">
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {formatCurrency(row.committedCents)}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 text-right">
                        <span className="text-sm tabular-nums text-muted-foreground">
                          {formatCurrency(row.actualCents)}
                        </span>
                      </TableCell>
                      <TableCell className="px-4 text-right">
                        <span className={cn("text-sm font-semibold tabular-nums", toneClass)}>
                          {formatCurrency(row.varianceCents)}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">
                          {row.variancePercent}% used
                        </span>
                      </TableCell>
                      <TableCell className="px-2" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-end">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
                                aria-label="Budget row actions"
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setActiveBucketKey(row.key)}>
                                Open details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                                New commitment
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filteredUnifiedRows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <UnifiedBudgetEmptyState editable={editable} onCreate={openCreateBucket} />
                    </TableCell>
                  </TableRow>
                )}
                {unifiedRows.length > 0 && (
                  <TableRow className="bg-muted/30 font-medium hover:bg-muted/30">
                    <TableCell className="px-4 py-3" />
                    <TableCell className="px-4 py-3 text-right text-xs uppercase tracking-wide text-muted-foreground">
                      Total
                    </TableCell>
                    <TableCell className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                      {formatCurrency(totalLinesCents)}
                    </TableCell>
                    <TableCell className="hidden px-4 py-3 text-right tabular-nums lg:table-cell">
                      {formatCurrency(committedTotal)}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(actualTotal)}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right tabular-nums">
                      {formatCurrency(varianceCents)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      <CostBucketEditorSheet
        open={bucketEditorOpen}
        onOpenChange={(open) => {
          setBucketEditorOpen(open)
          if (!open) setEditingBucketDraft(null)
        }}
        draft={editingBucketDraft}
        costCodes={costCodeOptions}
        existingBucketKeys={unifiedRows.map((row) => row.costCodeId).filter(Boolean) as string[]}
        onSave={upsertBucket}
        onRemove={
          editingBucketDraft?.lineIds?.length
            ? () => removeBucket(editingBucketDraft.lineIds ?? [])
            : undefined
        }
      />
      <BudgetBucketSheet
        bucket={activeBucket}
        open={activeBucket !== null}
        onOpenChange={(open) => {
          if (!open) setActiveBucketKey(null)
        }}
        commitments={activeBucketCommitments}
        commitmentsLoading={activeBucketCommitmentsLoading}
        onEditBucket={() => activeBucket && openEditBucket(activeBucket)}
        onCreateCommitment={() => setCreateOpen(true)}
        onEditCommitment={(commitment) => setEditCommitment(commitment)}
        onCommitmentLines={(commitment) => setLinesCommitment(commitment)}
        onCommitmentFiles={(commitment) => setFilesCommitment(commitment)}
      />
      <CommitmentCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projectId={projectId}
        companies={companyOptions}
      />
      <CommitmentEditDialog
        commitment={editCommitment}
        onClose={() => setEditCommitment(null)}
        projectId={projectId}
      />
      <CommitmentLinesDialog
        commitment={linesCommitment}
        onClose={() => setLinesCommitment(null)}
      />
      <CommitmentFilesDialog
        commitment={filesCommitment}
        projectId={projectId}
        onClose={() => setFilesCommitment(null)}
      />
    </div>
  )
}

// -------------------- Sub-components --------------------

function UnifiedBudgetEmptyState({
  editable,
  onCreate,
}: {
  editable: boolean
  onCreate: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ListOrdered className="h-6 w-6" />
      </div>
      <div className="max-w-[420px] text-center">
        <p className="font-medium">No cost buckets found</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Add cost-code buckets for labor, materials, subs, and allowances.
        </p>
      </div>
      {editable && (
        <Button size="sm" onClick={onCreate}>
          <Plus className="h-4 w-4" />
          Add cost bucket
        </Button>
      )}
    </div>
  )
}

function MobileMetric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: "ok" | "warning" | "danger"
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-sm font-semibold tabular-nums",
          tone === "danger" && "text-destructive",
          tone === "warning" && "text-amber-600 dark:text-amber-400",
        )}
      >
        {value}
      </p>
    </div>
  )
}

function BudgetBucketSheet({
  bucket,
  open,
  onOpenChange,
  commitments,
  commitmentsLoading,
  onEditBucket,
  onCreateCommitment,
  onEditCommitment,
  onCommitmentLines,
  onCommitmentFiles,
}: {
  bucket: {
    key: string
    costCodeId: string | null
    code?: string
    name: string
    category?: string | null
    lines: EditableBudgetLine[]
    budgetCents: number
    committedCents: number
    actualCents: number
    varianceCents: number
    variancePercent: number
    status: string
  } | null
  open: boolean
  onOpenChange: (open: boolean) => void
  commitments: Array<CommitmentSummary & { allocated_cents: number; matching_line_count: number }>
  commitmentsLoading: boolean
  onEditBucket: () => void
  onCreateCommitment: () => void
  onEditCommitment: (commitment: CommitmentSummary) => void
  onCommitmentLines: (commitment: CommitmentSummary) => void
  onCommitmentFiles: (commitment: CommitmentSummary) => void
}) {
  const toneClass =
    bucket?.status === "over"
      ? "text-destructive"
      : bucket?.status === "warning"
        ? "text-amber-600 dark:text-amber-400"
        : ""

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <div className="flex-1 overflow-y-auto px-4">
          <div className="pt-6 pb-4">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {bucket?.name ?? "Cost bucket"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              {bucket?.code ? `${bucket.code}` : "Uncoded"}{bucket?.category ? ` • ${bucket.category}` : ""}
            </SheetDescription>
          </div>

          <div className="space-y-6 pb-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Budget</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(bucket?.budgetCents)}</p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Committed</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(bucket?.committedCents)}</p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Actual</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(bucket?.actualCents)}</p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Variance</p>
                <p className={cn("mt-1 text-2xl font-semibold tabular-nums", toneClass)}>
                  {formatCurrency(bucket?.varianceCents)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{bucket?.variancePercent ?? 0}% used</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold">Budget</h4>
                  <p className="text-xs text-muted-foreground">One editable budget amount and note for this cost bucket.</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onEditBucket}>Edit budget</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {bucket?.lines[0]?.description?.trim() || "No scope note yet"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {bucket?.lines.length && bucket.lines.length > 1
                        ? `This bucket currently rolls up ${bucket.lines.length} internal entries. Editing will simplify them into one bucket.`
                        : "This note describes the planned scope for the cost code."}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Budget amount</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">{formatCurrency(bucket?.budgetCents)}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold">Commitments</h4>
                  <p className="text-xs text-muted-foreground">Subcontracts and POs allocated to this code.</p>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={onCreateCommitment}>
                      New commitment
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              {commitmentsLoading ? (
                <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                  Loading commitments...
                </div>
              ) : commitments.length ? (
                <div className="overflow-hidden rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/40">
                        <TableHead className="px-4">Commitment</TableHead>
                        <TableHead className="hidden md:table-cell px-4">Company</TableHead>
                        <TableHead className="w-[160px] px-4 text-right">Allocated</TableHead>
                        <TableHead className="w-[72px] px-2" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {commitments.map((c) => (
                        <TableRow key={c.id} className="group h-[56px] hover:bg-muted/30">
                          <TableCell className="px-4">
                            <span className="block truncate text-sm font-medium">{c.title}</span>
                            <span className="block text-xs text-muted-foreground">
                              {c.matching_line_count} {c.matching_line_count === 1 ? "allocation" : "allocations"}
                            </span>
                          </TableCell>
                          <TableCell className="hidden px-4 md:table-cell">
                            <span className="block truncate text-xs text-muted-foreground">
                              {c.company_name ?? "No company"}
                            </span>
                          </TableCell>
                          <TableCell className="px-4 text-right">
                            <span className="text-sm font-semibold tabular-nums">
                              {formatCurrency(c.allocated_cents)}
                            </span>
                          </TableCell>
                          <TableCell className="px-2">
                            <div className="flex items-center justify-end">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100">
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={() => onCommitmentLines(c)}>
                                    Allocation lines
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => onCommitmentFiles(c)}>
                                    Files
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => onEditCommitment(c)}>
                                    Edit commitment
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
                  No commitments allocated to this cost code yet.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button className="flex-1">
                  <MoreHorizontal className="h-4 w-4" />
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onEditBucket}>Edit budget</DropdownMenuItem>
                <DropdownMenuItem onClick={onCreateCommitment}>New commitment</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CostBucketEditorSheet({
  open,
  onOpenChange,
  draft,
  costCodes,
  existingBucketKeys,
  onSave,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: CostBucketDraft | null
  costCodes: CostCode[]
  existingBucketKeys: string[]
  onSave: (draft: CostBucketDraft) => void
  onRemove?: () => void
}) {
  const [costCodeId, setCostCodeId] = useState("__uncoded__")
  const [description, setDescription] = useState("")
  const [amountDollars, setAmountDollars] = useState("")

  useEffect(() => {
    if (!open) return
    setCostCodeId(draft?.costCodeId ?? "__uncoded__")
    setDescription(draft?.description ?? "")
    setAmountDollars(draft?.amountDollars ?? "")
  }, [draft, open])

  const amountCents = dollarsToCents(amountDollars)
  const canSave =
    description.trim().length > 0 &&
    amountCents !== null &&
    amountCents >= 0 &&
    (costCodeId === "__uncoded__" || !existingBucketKeys.includes(costCodeId) || draft?.costCodeId === costCodeId)

  const selectedCode = costCodeId === "__uncoded__" ? null : costCodes.find((code) => code.id === costCodeId)

  const submit = () => {
    if (!canSave) return
    onSave({
      key: draft?.key ?? null,
      costCodeId: costCodeId === "__uncoded__" ? null : costCodeId,
      description: description.trim(),
      amountDollars: amountDollars.trim() || "0",
      lineIds: draft?.lineIds ?? [],
    })
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
        style={{
          animationDuration: "150ms",
          transitionDuration: "150ms",
        } as CSSProperties}
      >
        <div className="flex-1 overflow-y-auto px-4">
          <div className="pt-6 pb-4">
            <SheetTitle className="text-lg font-semibold leading-none tracking-tight">
              {draft?.key ? "Edit cost bucket" : "Add cost bucket"}
            </SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              Set the budget amount and scope note for one cost code bucket.
            </SheetDescription>
          </div>

          <div className="space-y-5 pb-6">
            <div className="space-y-2">
            <Label>Cost code</Label>
            <Select value={costCodeId} onValueChange={setCostCodeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select cost code" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__uncoded__">Uncoded</SelectItem>
                {costCodes.map((code) => (
                  <SelectItem key={code.id} value={code.id}>
                    {code.code ? `${code.code} — ${code.name}` : code.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {selectedCode ? selectedCode.name : "Use uncoded only while roughing in the budget."}
            </p>
            {costCodeId !== "__uncoded__" && existingBucketKeys.includes(costCodeId) && draft?.costCodeId !== costCodeId ? (
              <p className="text-xs text-destructive">That cost code already has a bucket in this budget.</p>
            ) : null}
            </div>

            <div className="space-y-2">
              <Label>Scope note</Label>
              <Input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="e.g., Rough plumbing labor and trim"
              />
            </div>

            <div className="space-y-2">
              <Label>Amount</Label>
              <Input
                value={amountDollars}
                onChange={(event) => setAmountDollars(event.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="tabular-nums"
              />
              <p className="text-xs text-muted-foreground">
                Preview: {amountCents === null ? "Invalid amount" : formatCurrency(amountCents)}
              </p>
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 border-t bg-background p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              {draft?.lineIds?.length && onRemove ? (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => {
                    onRemove()
                    onOpenChange(false)
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  Remove bucket
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={submit} disabled={!canSave}>
                {draft?.key ? "Save bucket" : "Add bucket"}
              </Button>
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", className)} />
      {label}
    </span>
  )
}

function HeroStat({
  label,
  value,
  meta,
  tone,
}: {
  label: string
  value: string
  meta?: string
  tone?: "ok" | "warning" | "danger"
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-baseline gap-2">
        <p
          className={cn(
            "text-lg font-semibold tabular-nums",
            tone === "danger" && "text-destructive",
            tone === "warning" && "text-amber-600 dark:text-amber-400",
          )}
        >
          {value}
        </p>
        {meta && (
          <span
            className={cn(
              "text-xs",
              tone === "danger"
                ? "text-destructive"
                : tone === "warning"
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {meta}
          </span>
        )}
      </div>
    </div>
  )
}

// ---- Commitment dialogs ----

function CommitmentCreateDialog({
  open,
  onOpenChange,
  projectId,
  companies,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  companies: Company[]
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [companyId, setCompanyId] = useState<string>(companies[0]?.id ?? "")
  const [title, setTitle] = useState("")
  const [totalDollars, setTotalDollars] = useState("")
  const [status, setStatus] = useState("approved")

  useEffect(() => {
    if (open) {
      setCompanyId(companies[0]?.id ?? "")
      setTitle("")
      setTotalDollars("")
      setStatus("approved")
    }
  }, [open, companies])

  const submit = () => {
    if (!companyId) {
      toast({ title: "Company required" })
      return
    }
    if (title.trim().length < 2) {
      toast({ title: "Title required" })
      return
    }
    const n = Number(totalDollars)
    if (!Number.isFinite(n) || n < 0) {
      toast({ title: "Invalid total" })
      return
    }

    startTransition(async () => {
      try {
        await createProjectCommitmentAction(projectId, {
          project_id: projectId,
          company_id: companyId,
          title: title.trim(),
          total_cents: Math.round(n * 100),
          status,
        })
        toast({ title: "Commitment created" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({
          title: "Unable to create commitment",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New commitment</DialogTitle>
          <DialogDescription>
            Create a subcontract or PO to track spend against this project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Company</Label>
            <Select value={companyId} onValueChange={setCompanyId}>
              <SelectTrigger>
                <SelectValue placeholder="Select company" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Plumbing subcontract"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Total ($)</Label>
              <Input
                value={totalDollars}
                onChange={(e) => setTotalDollars(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="canceled">Canceled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={submit}>
              {isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CommitmentEditDialog({
  commitment,
  onClose,
  projectId,
}: {
  commitment: CommitmentSummary | null
  onClose: () => void
  projectId: string
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [title, setTitle] = useState("")
  const [totalDollars, setTotalDollars] = useState("")
  const [status, setStatus] = useState("draft")

  useEffect(() => {
    if (commitment) {
      setTitle(commitment.title ?? "")
      setTotalDollars(((commitment.total_cents ?? 0) / 100).toFixed(2))
      setStatus(String(commitment.status ?? "draft"))
    }
  }, [commitment])

  const submit = () => {
    if (!commitment) return
    if (title.trim().length < 2) {
      toast({ title: "Title required" })
      return
    }
    const n = Number(totalDollars)
    if (!Number.isFinite(n) || n < 0) {
      toast({ title: "Invalid total" })
      return
    }

    startTransition(async () => {
      try {
        await updateProjectCommitmentAction(projectId, commitment.id, {
          title: title.trim(),
          status,
          total_cents: Math.round(n * 100),
        })
        toast({ title: "Commitment updated" })
        onClose()
        router.refresh()
      } catch (error) {
        toast({
          title: "Unable to update commitment",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Dialog open={commitment !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit commitment</DialogTitle>
          <DialogDescription>Update title, total, and status.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Total ($)</Label>
              <Input
                value={totalDollars}
                onChange={(e) => setTotalDollars(e.target.value)}
                inputMode="decimal"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="canceled">Canceled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={submit}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CommitmentLinesDialog({
  commitment,
  onClose,
}: {
  commitment: CommitmentSummary | null
  onClose: () => void
}) {
  const { toast } = useToast()
  const [lines, setLines] = useState<CommitmentLine[]>([])
  const [codes, setCodes] = useState<CostCode[]>([])
  const [loading, setLoading] = useState(false)
  const [editingLine, setEditingLine] = useState<CommitmentLine | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!commitment) {
      setLines([])
      return
    }
    let cancelled = false
    setLoading(true)
    Promise.all([listCommitmentLinesAction(commitment.id), listCostCodesAction()])
      .then(([l, c]) => {
        if (cancelled) return
        setLines(l)
        setCodes(c)
      })
      .catch((error) => {
        if (!cancelled) {
          toast({ title: "Unable to load lines", description: (error as Error).message })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [commitment, toast])

  const reload = async () => {
    if (!commitment) return
    const l = await listCommitmentLinesAction(commitment.id)
    setLines(l)
  }

  const totalCents = lines.reduce((s, l) => s + (l.total_cents ?? 0), 0)

  return (
    <Dialog open={commitment !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-4xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>{commitment?.title ?? "Commitment lines"}</DialogTitle>
          <DialogDescription>
            Line items with cost codes, quantities, and unit costs.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-3 overflow-y-auto">
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground tabular-nums">
              {lines.length} {lines.length === 1 ? "line" : "lines"} · Total{" "}
              {formatCurrency(totalCents)}
            </p>
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" />
              Add line
            </Button>
          </div>

          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading...</p>
          ) : lines.length === 0 ? (
            <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              No line items yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="px-3">Cost code</TableHead>
                    <TableHead className="px-3">Description</TableHead>
                    <TableHead className="px-3 text-right">Qty</TableHead>
                    <TableHead className="px-3">Unit</TableHead>
                    <TableHead className="px-3 text-right">Unit cost</TableHead>
                    <TableHead className="px-3 text-right">Total</TableHead>
                    <TableHead className="w-20 px-3" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell className="px-3 font-mono text-xs">
                        {line.cost_code_code ?? "—"}
                      </TableCell>
                      <TableCell className="px-3">{line.description}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums">
                        {line.quantity}
                      </TableCell>
                      <TableCell className="px-3">{line.unit}</TableCell>
                      <TableCell className="px-3 text-right tabular-nums">
                        {formatCurrency(line.unit_cost_cents)}
                      </TableCell>
                      <TableCell className="px-3 text-right font-medium tabular-nums">
                        {formatCurrency(line.total_cents)}
                      </TableCell>
                      <TableCell className="px-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setEditingLine(line)}
                        >
                          Edit
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/30 font-medium">
                    <TableCell colSpan={5} className="px-3 text-right text-xs uppercase tracking-wide text-muted-foreground">
                      Total
                    </TableCell>
                    <TableCell className="px-3 text-right tabular-nums">
                      {formatCurrency(totalCents)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <CommitmentLineDialog
          open={creating || editingLine !== null}
          onOpenChange={(o) => {
            if (!o) {
              setCreating(false)
              setEditingLine(null)
            }
          }}
          commitmentId={commitment?.id ?? ""}
          line={editingLine}
          costCodes={codes}
          onSaved={async () => {
            setCreating(false)
            setEditingLine(null)
            await reload()
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function CommitmentLineDialog({
  open,
  onOpenChange,
  commitmentId,
  line,
  costCodes,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commitmentId: string
  line: CommitmentLine | null
  costCodes: CostCode[]
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const [costCodeId, setCostCodeId] = useState("")
  const [description, setDescription] = useState("")
  const [quantity, setQuantity] = useState("1")
  const [unit, setUnit] = useState("")
  const [unitCost, setUnitCost] = useState("0.00")

  useEffect(() => {
    if (open) {
      setCostCodeId(line?.cost_code_id ?? "")
      setDescription(line?.description ?? "")
      setQuantity(line?.quantity?.toString() ?? "1")
      setUnit(line?.unit ?? "")
      setUnitCost(((line?.unit_cost_cents ?? 0) / 100).toFixed(2))
    }
  }, [open, line])

  const total = (Number(quantity) || 0) * (Number(unitCost) || 0)

  const submit = () => {
    if (!costCodeId) {
      toast({ title: "Cost code required" })
      return
    }
    if (!description.trim()) {
      toast({ title: "Description required" })
      return
    }
    if (!unit.trim()) {
      toast({ title: "Unit required" })
      return
    }
    const qty = Number(quantity)
    const cost = Math.round(Number(unitCost) * 100)
    if (!Number.isFinite(qty) || qty <= 0) {
      toast({ title: "Invalid quantity" })
      return
    }
    if (!Number.isFinite(cost) || cost < 0) {
      toast({ title: "Invalid unit cost" })
      return
    }

    startTransition(async () => {
      try {
        const payload = {
          cost_code_id: costCodeId,
          description: description.trim(),
          quantity: qty,
          unit: unit.trim(),
          unit_cost_cents: cost,
        }
        if (line) {
          await updateCommitmentLineAction(line.id, payload)
        } else {
          await createCommitmentLineAction(commitmentId, payload)
        }
        onSaved()
      } catch (error) {
        toast({
          title: "Unable to save line",
          description: (error as Error).message,
        })
      }
    })
  }

  const remove = () => {
    if (!line) return
    startTransition(async () => {
      try {
        await deleteCommitmentLineAction(line.id)
        onSaved()
      } catch (error) {
        toast({
          title: "Unable to remove line",
          description: (error as Error).message,
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{line ? "Edit line" : "Add line"}</DialogTitle>
          <DialogDescription>
            {line ? "Update the line details." : "Add a new line to this commitment."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1.5">
            <Label>Cost code</Label>
            <Select value={costCodeId} onValueChange={setCostCodeId}>
              <SelectTrigger>
                <SelectValue placeholder="Select cost code" />
              </SelectTrigger>
              <SelectContent>
                {costCodes.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>Description</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Line item description"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Quantity</Label>
            <Input
              type="number"
              step="0.01"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit</Label>
            <Input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="SF, LF, EA..."
            />
          </div>
          <div className="space-y-1.5">
            <Label>Unit cost ($)</Label>
            <Input
              type="number"
              step="0.01"
              value={unitCost}
              onChange={(e) => setUnitCost(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Total</Label>
            <div className="flex h-9 items-center rounded-md border bg-muted px-3 text-sm tabular-nums">
              ${total.toFixed(2)}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between pt-2">
          <div>
            {line && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={remove}
                disabled={isPending}
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={isPending}>
              {isPending ? "Saving..." : line ? "Update" : "Add"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CommitmentFilesDialog({
  commitment,
  projectId,
  onClose,
}: {
  commitment: CommitmentSummary | null
  projectId: string
  onClose: () => void
}) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = async () => {
    if (!commitment) return
    const links = await listAttachmentsAction("commitment", commitment.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      })),
    )
  }

  useEffect(() => {
    if (!commitment) {
      setAttachments([])
      return
    }
    setLoading(true)
    refresh().finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commitment])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!commitment) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "financials")
      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "commitment", commitment.id, projectId, linkRole)
    }
    await refresh()
  }

  const handleDetach = async (linkId: string) => {
    await detachFileLinkAction(linkId)
    await refresh()
  }

  return (
    <Dialog open={commitment !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{commitment?.title ?? "Commitment files"}</DialogTitle>
          <DialogDescription>Subcontract documents and supporting files.</DialogDescription>
        </DialogHeader>
        {commitment && (
          <EntityAttachments
            entityType="commitment"
            entityId={commitment.id}
            projectId={projectId}
            attachments={attachments}
            onAttach={handleAttach}
            onDetach={handleDetach}
            readOnly={loading}
            compact
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
