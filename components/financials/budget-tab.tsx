"use client"

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  ListOrdered,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react"

import type { CostCode, Company } from "@/lib/types"
import type { CommitmentSummary, CommitmentLine } from "@/lib/services/commitments"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"

import {
  acknowledgeVarianceAlertAction,
  createProjectBudgetAction,
  replaceProjectBudgetLinesAction,
  runVarianceScanAction,
  updateCostCodeProgressAction,
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

type CommitmentCreateDraft = {
  costCodeId: string | null
  defaultAmountDollars: string
  defaultScope: string
}

interface BudgetTabProps {
  projectId: string
  project: any // Project
  budgetData: any | null
  costCodes: CostCode[]
  costCodesEnabled?: boolean
  varianceAlerts: any[]
  commitments: CommitmentSummary[]
  companies: Company[]
  budgetBucketCompanies: Record<string, string[]>
  feeSummary?: ProjectFeeBillingSummary | null
  gmpSummary?: ProjectGmpControlSummary | null
  loadErrors?: string[]
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

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <span className="text-[11px] font-medium uppercase text-muted-foreground">{label}</span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  )
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
  project,
  budgetData,
  costCodes,
  costCodesEnabled = true,
  varianceAlerts,
  commitments,
  companies,
  budgetBucketCompanies,
  feeSummary = null,
  gmpSummary = null,
  loadErrors = [],
}: BudgetTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const currentBudget = budgetData?.budget ?? null
  const summary = budgetData?.summary ?? null
  const editable = true // Always editable as a living document

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
    () => (costCodesEnabled ? [...(costCodes ?? [])].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")) : []),
    [costCodes, costCodesEnabled],
  )

  const costCodeById = useMemo(() => {
    const map = new Map<string, CostCode>()
    for (const code of costCodes ?? []) {
      map.set(code.id, code)
    }
    return map
  }, [costCodes])

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

  const persistBudgetLines = (nextLines: EditableBudgetLine[], message: string) => {
    if (!editable) return
    if (nextLines.length === 0) {
      toast({ title: "Add at least one cost bucket" })
      return
    }

    const nextErrors = nextLines.filter((line) => {
      if (!line.description.trim()) return true
      const cents = dollarsToCents(line.amount_dollars)
      return cents == null || cents < 0
    })

    if (nextErrors.length > 0) {
      toast({
        title: "Fix cost bucket errors",
        description: "Some buckets are missing a scope note or have an invalid amount.",
      })
      return
    }

    const payloadLines = nextLines.map((line) => ({
      cost_code_id: costCodesEnabled ? line.cost_code_id : null,
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
          toast({ title: message })
        } else {
          await replaceProjectBudgetLinesAction(projectId, currentBudget.id, payloadLines)
          toast({ title: message })
        }
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to save budget", description: (error as Error).message })
      }
    })
  }

  const upsertBucket = (draft: CostBucketDraft) => {
    const nextLine: EditableBudgetLine = {
      id: draft.lineIds?.[0] ?? crypto.randomUUID(),
      cost_code_id: costCodesEnabled ? draft.costCodeId : null,
      description: draft.description.trim(),
      amount_dollars: draft.amountDollars.trim() || "0",
    }

    const removeIds = new Set(draft.lineIds ?? [])
    const existingLines = lines.filter((line) => removeIds.has(line.id))
    const unchangedLines = lines.filter((line) => !removeIds.has(line.id))
    const targetCents = dollarsToCents(draft.amountDollars) ?? 0

    const replacementLines =
      existingLines.length > 1
        ? existingLines.map((line, index) => {
            const currentBucketCents = existingLines.reduce(
              (sum, item) => sum + (dollarsToCents(item.amount_dollars) ?? 0),
              0,
            )
            const currentLineCents = dollarsToCents(line.amount_dollars) ?? 0
            const scaledCents =
              currentBucketCents > 0
                ? Math.round((currentLineCents / currentBucketCents) * targetCents)
                : index === 0
                  ? targetCents
                  : 0
            const alreadyAllocated = existingLines
              .slice(0, index)
              .reduce((sum, item) => {
                const itemCents = dollarsToCents(item.amount_dollars) ?? 0
                return sum + (currentBucketCents > 0 ? Math.round((itemCents / currentBucketCents) * targetCents) : 0)
              }, 0)
            const nextLineCents =
              index === existingLines.length - 1 ? Math.max(0, targetCents - alreadyAllocated) : scaledCents
            return {
              ...line,
              cost_code_id: costCodesEnabled ? draft.costCodeId : null,
              description: index === 0 ? draft.description.trim() : line.description,
              amount_dollars: (nextLineCents / 100).toFixed(2),
            }
          })
        : [nextLine]

    const nextLines = [...unchangedLines, ...replacementLines]
    setLines(nextLines)
    setBucketEditorOpen(false)
    setEditingBucketDraft(null)
    persistBudgetLines(nextLines, draft.lineIds?.length ? "Cost bucket updated" : "Cost bucket added")
  }

  const removeBucket = (lineIds: string[]) => {
    const ids = new Set(lineIds)
    const nextLines = lines.filter((line) => !ids.has(line.id))
    if (nextLines.length === 0) {
      toast({ title: "At least one cost bucket is required" })
      return
    }
    setLines(nextLines)
    persistBudgetLines(nextLines, "Cost bucket removed")
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
  const activeAlerts = (varianceAlerts ?? []).filter((a) => a.status === "active")

  // ---------- Commitments state ----------
  const companyOptions = useMemo(
    () => [...(companies ?? [])].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
    [companies],
  )

  const [createOpen, setCreateOpen] = useState(false)
  const [createCommitmentDraft, setCreateCommitmentDraft] =
    useState<CommitmentCreateDraft | null>(null)
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
        coAdjustmentCents: number
        adjustedBudgetCents: number
        committedCents: number
        actualCents: number
        invoicedCents: number
        varianceCents: number
        variancePercent: number
        status: string
        percentComplete: number | null
        eacCents: number
        costToCompleteCents: number
        varianceAtCompletionCents: number
        assignedCompanies: string[]
      }
    >()

    for (const line of lines) {
      const lineCostCodeId = costCodesEnabled ? line.cost_code_id : null
      const key = lineCostCodeId ?? "uncoded"
      const code = lineCostCodeId ? costCodeById.get(lineCostCodeId) : null
      const breakdown = breakdownByCostCode.get(key)
      const existing = grouped.get(key) ?? {
        key,
        costCodeId: lineCostCodeId,
        code: code?.code,
        name: code?.name ?? "Uncoded",
        category: code?.category ?? null,
        lines: [] as EditableBudgetLine[],
        budgetCents: 0,
        coAdjustmentCents: breakdown?.co_adjustment_cents ?? 0,
        adjustedBudgetCents: breakdown?.adjusted_budget_cents ?? 0,
        committedCents: breakdown?.committed_cents ?? 0,
        actualCents: breakdown?.actual_cents ?? 0,
        invoicedCents: breakdown?.invoiced_cents ?? 0,
        varianceCents: breakdown?.variance_cents ?? 0,
        variancePercent: breakdown?.variance_percent ?? 0,
        status: breakdown?.status ?? "ok",
        percentComplete: breakdown?.percent_complete ?? null,
        eacCents: breakdown?.eac_cents ?? 0,
        costToCompleteCents: breakdown?.cost_to_complete_cents ?? 0,
        varianceAtCompletionCents: breakdown?.variance_at_completion_cents ?? 0,
        assignedCompanies: budgetBucketCompanies[key] ?? [],
      }
      existing.lines.push(line)
      existing.budgetCents += dollarsToCents(line.amount_dollars) ?? 0

      // Re-calculate adjustedBudget after appending new lines if they were not saved yet
      existing.adjustedBudgetCents = existing.budgetCents + existing.coAdjustmentCents

      grouped.set(key, existing)
    }

    for (const [key, breakdown] of breakdownByCostCode) {
      if (grouped.has(key)) continue
      const breakdownCostCodeId = costCodesEnabled ? breakdown.cost_code_id ?? null : null
      const code = breakdownCostCodeId ? costCodeById.get(breakdownCostCodeId) : null
      grouped.set(key, {
        key,
        costCodeId: breakdownCostCodeId,
        code: code?.code,
        name: code?.name ?? "Uncoded",
        category: code?.category ?? null,
        lines: [] as EditableBudgetLine[],
        budgetCents: breakdown.budget_cents ?? 0,
        coAdjustmentCents: breakdown.co_adjustment_cents ?? 0,
        adjustedBudgetCents: breakdown.adjusted_budget_cents ?? 0,
        committedCents: breakdown.committed_cents ?? 0,
        actualCents: breakdown.actual_cents ?? 0,
        invoicedCents: breakdown.invoiced_cents ?? 0,
        varianceCents: breakdown.variance_cents ?? 0,
        variancePercent: breakdown.variance_percent ?? 0,
        status: breakdown.status ?? "ok",
        percentComplete: breakdown.percent_complete ?? null,
        eacCents: breakdown.eac_cents ?? 0,
        costToCompleteCents: breakdown.cost_to_complete_cents ?? 0,
        varianceAtCompletionCents: breakdown.variance_at_completion_cents ?? 0,
        assignedCompanies: budgetBucketCompanies[key] ?? [],
      })
    }

    return Array.from(grouped.values()).sort((a, b) => {
      const codeA = a.code ?? "zzz"
      const codeB = b.code ?? "zzz"
      return codeA.localeCompare(codeB) || a.name.localeCompare(b.name)
    })
  }, [breakdownByCostCode, budgetBucketCompanies, costCodeById, costCodesEnabled, lines])

  const filteredUnifiedRows = useMemo(() => {
    const term = budgetLineSearch.trim().toLowerCase()
    if (!term) return unifiedRows
    return unifiedRows.filter((row) =>
      [
        row.code,
        row.name,
        row.category,
        ...row.assignedCompanies,
        ...row.lines.map((line) => line.description),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term)),
    )
  }, [budgetLineSearch, unifiedRows])

  const activeBucket = unifiedRows.find((row) => row.key === activeBucketKey) ?? null

  const openCreateCommitment = (bucket?: {
    costCodeId: string | null
    budgetCents: number
    committedCents: number
    lines: EditableBudgetLine[]
  } | null) => {
    const remainingToBuyCents = bucket
      ? Math.max(0, bucket.budgetCents - bucket.committedCents)
      : 0

    setCreateCommitmentDraft({
      costCodeId: costCodesEnabled ? bucket?.costCodeId ?? costCodeOptions[0]?.id ?? null : null,
      defaultAmountDollars:
        remainingToBuyCents > 0 ? (remainingToBuyCents / 100).toFixed(2) : "",
      defaultScope: bucket?.lines[0]?.description?.trim() || "",
    })
    setCreateOpen(true)
  }

  useEffect(() => {
    if (!activeBucket) {
      setActiveBucketCommitments([])
      return
    }

    let cancelled = false
    setActiveBucketCommitmentsLoading(true)
    fetchBudgetBucketCommitmentsAction(projectId, costCodesEnabled ? activeBucket.costCodeId : null)
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
  }, [activeBucket, costCodesEnabled, projectId])

  // ---------- Render ----------
  const contractValue =
    project?.billing_contract?.total_cents ??
    project?.total_contract_value_cents ??
    0
  const contractBilled = summary?.total_invoiced_cents ?? 0
  const percentComplete = summary?.total_eac_cents > 0 ? (summary?.total_actual_cents ?? 0) / summary.total_eac_cents : 0
  const earnedRevenue = Math.round(contractValue * percentComplete)
  const overUnderBilling = contractBilled - earnedRevenue
  const showFeeSummary = feeSummary?.enabled || feeSummary?.billing_model === "cost_plus_fixed_fee"

  return (
    <div className="-mx-4 -mt-6 -mb-4 flex flex-col bg-card">
      {loadErrors.length > 0 && <FinancialLoadWarning errors={loadErrors} />}
      {activeAlerts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-amber-500/30 bg-amber-500/[0.04] px-6 py-2.5 text-sm">
          <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-4 w-4" />
            {activeAlerts.length} variance {activeAlerts.length === 1 ? "alert" : "alerts"}
          </div>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {activeAlerts.slice(0, 2).map((a, i) => (
              <span key={a.id}>
                {i > 0 && " · "}
                <span className="capitalize">{a.alert_type?.replaceAll("_", " ") ?? "Alert"}</span>
                {typeof a.current_percent === "number" ? ` (${a.current_percent}%)` : ""}
              </span>
            ))}
            {activeAlerts.length > 2 && ` · +${activeAlerts.length - 2} more`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={runScan} disabled={isPending || !currentBudget}>
              Refresh alerts
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              disabled={isPending}
              onClick={() => activeAlerts.forEach((a) => acknowledge(a.id, "acknowledged"))}
            >
              Ack all
            </Button>
          </div>
        </div>
      )}

      {/* Project WIP Summary */}
      <div className="border-b px-6 py-4">
        <div className="mb-3 text-sm font-semibold">Project WIP & Forecast</div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5">
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Contract Value</span>
            <span className="font-mono text-sm">{formatCurrency(contractValue)}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Earned Rev</span>
            <span className="font-mono text-sm">{formatCurrency(earnedRevenue)}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Billed Rev</span>
            <span className="font-mono text-sm">{formatCurrency(contractBilled)}</span>
          </div>
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Over/(Under)</span>
            <span className={cn("font-mono text-sm", overUnderBilling > 0 ? "text-emerald-600 dark:text-emerald-400" : overUnderBilling < 0 ? "text-destructive" : "")}>
              {formatCurrency(overUnderBilling)}
            </span>
          </div>
          <div className="flex flex-col gap-1 rounded-md border p-3">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">EAC</span>
            <span className="font-mono text-sm">{formatCurrency(summary?.total_eac_cents)}</span>
          </div>
        </div>
        {showFeeSummary ? (
          <div className="mt-4 border-t pt-4">
            <div className="mb-3 text-sm font-semibold">Fixed Fee</div>
            {feeSummary?.enabled ? (
              <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-5">
                <SummaryMetric label="Total fee" value={formatCurrency(feeSummary.total_fee_cents)} />
                <SummaryMetric label="Earned fee" value={formatCurrency(feeSummary.earned_fee_cents)} />
                <SummaryMetric label="Billed fee" value={formatCurrency(feeSummary.billed_fee_cents)} />
                <SummaryMetric label="Billable now" value={formatCurrency(feeSummary.billable_fee_cents)} />
                <SummaryMetric label="Remaining fee" value={formatCurrency(feeSummary.remaining_fee_cents)} />
              </div>
            ) : (
              <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
                {feeSummary?.reason ?? "Fixed-fee billing setup is incomplete."}
              </div>
            )}
          </div>
        ) : null}
        {gmpSummary?.enabled ? (
          <div className="mt-4 border-t pt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">GMP Control</div>
              <span
                className={cn(
                  "rounded-sm px-2 py-1 text-[11px] font-medium uppercase",
                  gmpSummary.status === "overrun"
                    ? "bg-destructive/10 text-destructive"
                    : gmpSummary.status === "watch"
                      ? "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                )}
              >
                {gmpSummary.status.replaceAll("_", " ")}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4 lg:grid-cols-6">
              <SummaryMetric label="Revised GMP" value={formatCurrency(gmpSummary.revised_gmp_cents)} />
              <SummaryMetric label="Inside EAC" value={formatCurrency(gmpSummary.inside_gmp_eac_cents)} />
              <SummaryMetric label="Outside EAC" value={formatCurrency(gmpSummary.outside_gmp_eac_cents)} />
              <SummaryMetric
                label={gmpSummary.overrun_cents > 0 ? "Overrun" : "Savings"}
                value={formatCurrency(gmpSummary.overrun_cents > 0 ? gmpSummary.overrun_cents : gmpSummary.savings_cents)}
              />
              <SummaryMetric label="Owner savings" value={formatCurrency(gmpSummary.owner_savings_cents)} />
              <SummaryMetric label="Builder savings" value={formatCurrency(gmpSummary.builder_savings_cents)} />
            </div>
            {gmpSummary.warnings.length > 0 ? (
              <div className="mt-3 grid gap-2">
                {gmpSummary.warnings.map((warning) => (
                  <div
                    key={warning.code}
                    className={cn(
                      "flex items-start gap-2 border px-3 py-2 text-sm",
                      warning.severity === "critical"
                        ? "border-destructive/30 bg-destructive/5 text-destructive"
                        : warning.severity === "warning"
                          ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
                          : "bg-muted/30 text-muted-foreground",
                    )}
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {warning.message}
                      {typeof warning.amount_cents === "number" ? ` ${formatCurrency(warning.amount_cents)}.` : ""}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Sticky controls bar - sits flush below the tab bar when scrolled */}
      <div className="sticky top-11 z-[5] flex items-center gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <Input
          placeholder="Search cost codes or scope..."
          className="h-9 flex-1 sm:max-w-md"
          value={budgetLineSearch}
          onChange={(event) => setBudgetLineSearch(event.target.value)}
        />
        <div className="ml-auto flex items-center gap-2">
          {editable && (
            <Button size="sm" onClick={openCreateBucket}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Add bucket</span>
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="h-9 w-9 shrink-0">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Budget actions</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => openCreateCommitment()}
                disabled={companyOptions.length === 0}
              >
                New commitment
              </DropdownMenuItem>
              <DropdownMenuItem onClick={runScan} disabled={isPending || !currentBudget}>
                Refresh budget alerts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="border-t md:hidden">
        {filteredUnifiedRows.length === 0 ? (
          <div className="px-4 py-12">
            <UnifiedBudgetEmptyState editable={editable} onCreate={openCreateBucket} />
          </div>
        ) : (
          <ul className="divide-y">
            {filteredUnifiedRows.map((row) => {
              const rowRemainingToBuy = Math.max(0, row.budgetCents - row.committedCents)
              const rowToneClass =
                row.status === "over"
                  ? "text-destructive"
                  : row.status === "warning"
                    ? "text-amber-600 dark:text-amber-400"
                    : ""
              const rowPct =
                row.budgetCents > 0
                  ? Math.min(100, (row.actualCents / row.budgetCents) * 100)
                  : 0
              const rowCommittedPct =
                row.budgetCents > 0
                  ? Math.min(100, (row.committedCents / row.budgetCents) * 100)
                  : 0
              return (
                <li key={row.key}>
                  <button
                    type="button"
                    onClick={() => setActiveBucketKey(row.key)}
                    className="block w-full px-4 py-4 text-left transition-colors hover:bg-muted/40 active:bg-muted"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">
                            {row.code ?? "Uncoded"}
                          </span>
                          {row.status === "over" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                          )}
                          {row.status === "warning" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          )}
                        </div>
                        <p className="mt-1.5 line-clamp-1 text-sm font-medium">{row.name}</p>
                        {row.assignedCompanies.length > 0 && (
                          <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                            {row.assignedCompanies.join(", ")}
                          </p>
                        )}
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-semibold tabular-nums">
                          {formatCurrency(row.budgetCents, { compact: true })}
                        </p>
                        <p className={cn("text-[11px] tabular-nums", rowToneClass || "text-muted-foreground")}>
                          {row.variancePercent}%
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

      {/* Desktop unified table */}
      <div className="hidden border-t md:block overflow-x-auto">
        <Table className="w-full min-w-[1000px]">
          <TableHeader>
            <TableRow className="border-b bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-[120px] px-4 text-xs uppercase tracking-wide">Code</TableHead>
              <TableHead className="min-w-[200px] px-4 text-xs uppercase tracking-wide">Scope</TableHead>
              <TableHead className="hidden xl:table-cell w-[110px] px-4 text-right text-xs uppercase tracking-wide">Original</TableHead>
              <TableHead className="hidden xl:table-cell w-[110px] px-4 text-right text-xs uppercase tracking-wide">Approved CO</TableHead>
              <TableHead className="w-[120px] px-4 text-right text-xs uppercase tracking-wide">Revised</TableHead>
              <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">Committed</TableHead>
              <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">Actual</TableHead>
              <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">CTC</TableHead>
              <TableHead className="w-[120px] px-4 text-right text-xs uppercase tracking-wide">EAC</TableHead>
              <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">VAC</TableHead>
              <TableHead className="w-[100px] px-4 text-right text-xs uppercase tracking-wide">% Comp</TableHead>
              <TableHead className="w-[56px] px-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUnifiedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={12} className="h-56 text-center hover:bg-transparent">
                  <UnifiedBudgetEmptyState editable={editable} onCreate={openCreateBucket} />
                </TableCell>
              </TableRow>
            ) : (
              filteredUnifiedRows.map((row) => {
                const toneClass =
                  row.status === "over"
                    ? "text-destructive"
                    : row.status === "warning"
                      ? "text-amber-600 dark:text-amber-400"
                      : ""
                const rowRemainingToBuy = Math.max(0, row.budgetCents - row.committedCents)
                const rowActualPct =
                  row.budgetCents > 0
                    ? Math.min(100, (row.actualCents / row.budgetCents) * 100)
                    : 0
                const rowCommittedPct =
                  row.budgetCents > 0
                    ? Math.min(100, (row.committedCents / row.budgetCents) * 100)
                    : 0
                return (
                  <TableRow
                    key={row.key}
                    className="group h-[60px] cursor-pointer hover:bg-muted/30"
                    onClick={() => setActiveBucketKey(row.key)}
                  >
                    <TableCell className="px-4">
                      <div className="flex items-center gap-2">
                        {row.status === "over" ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-label="Over budget" />
                        ) : row.status === "warning" ? (
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-label="Near budget" />
                        ) : (
                          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" />
                        )}
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">
                          {row.code ?? "Uncoded"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-0 px-4">
                      <span className="block truncate text-sm font-medium">{row.name}</span>
                      {row.lines.length > 0 && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.lines.length === 1
                            ? row.lines[0].description
                            : `${row.lines.length} budget lines`}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="hidden px-4 text-right tabular-nums text-muted-foreground xl:table-cell">
                      <span className="text-sm">{formatCurrency(row.budgetCents)}</span>
                    </TableCell>
                    <TableCell className="hidden px-4 text-right tabular-nums text-muted-foreground xl:table-cell">
                      <span className="text-sm">{formatCurrency(row.coAdjustmentCents)}</span>
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums">
                      <span className="text-sm font-medium">{formatCurrency(row.adjustedBudgetCents)}</span>
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
                      <span className="text-sm">{formatCurrency(row.committedCents)}</span>
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
                      <span className="text-sm">{formatCurrency(row.actualCents)}</span>
                    </TableCell>
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
                          <DropdownMenuItem onClick={() => setActiveBucketKey(row.key)}>
                            Open details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openCreateCommitment(row)}>
                            New commitment
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>

      <CostBucketEditorSheet
        open={bucketEditorOpen}
        onOpenChange={(open) => {
          setBucketEditorOpen(open)
          if (!open) setEditingBucketDraft(null)
        }}
        draft={editingBucketDraft}
        costCodes={costCodeOptions}
        costCodesEnabled={costCodesEnabled}
        existingBucketKeys={unifiedRows.map((row) => row.costCodeId).filter(Boolean) as string[]}
        onSave={upsertBucket}
        onRemove={
          editingBucketDraft?.lineIds?.length
            ? () => removeBucket(editingBucketDraft.lineIds ?? [])
            : undefined
        }
      />
      <BudgetBucketSheet
        projectId={projectId}
        bucket={activeBucket}
        open={activeBucket !== null}
        onOpenChange={(open) => {
          if (!open) setActiveBucketKey(null)
        }}
        commitments={activeBucketCommitments}
        commitmentsLoading={activeBucketCommitmentsLoading}
        onEditBucket={() => activeBucket && openEditBucket(activeBucket)}
        onCreateCommitment={() => openCreateCommitment(activeBucket)}
        onEditCommitment={(commitment) => setEditCommitment(commitment)}
        onCommitmentLines={(commitment) => setLinesCommitment(commitment)}
        onCommitmentFiles={(commitment) => setFilesCommitment(commitment)}
      />
      <CommitmentCreateDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreateCommitmentDraft(null)
        }}
        projectId={projectId}
        companies={companyOptions}
        costCodes={costCodeOptions}
        costCodesEnabled={costCodesEnabled}
        draft={createCommitmentDraft}
      />
      <CommitmentEditDialog
        commitment={editCommitment}
        onClose={() => setEditCommitment(null)}
        projectId={projectId}
      />
      <CommitmentLinesDialog
        commitment={linesCommitment}
        onClose={() => setLinesCommitment(null)}
        costCodesEnabled={costCodesEnabled}
      />
      <CommitmentFilesDialog
        commitment={filesCommitment}
        projectId={projectId}
        onClose={() => setFilesCommitment(null)}
      />
    </div>
  )
}

function FinancialLoadWarning({ errors }: { errors: string[] }) {
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-sm text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">Some financial data could not load.</span>
          <span className="text-amber-800/40 dark:text-amber-400/30">•</span>
          <span className="text-amber-800 dark:text-amber-300">{errors.join(" · ")}</span>
        </div>
      </div>
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

function BudgetBucketSheet({
  projectId,
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
  projectId: string
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
    percentComplete: number | null
    eacCents: number
    costToCompleteCents: number
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
  const remainingToBuyCents = Math.max(
    0,
    (bucket?.budgetCents ?? 0) - (bucket?.committedCents ?? 0),
  )
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
              {bucket?.name ?? "Cost code"}
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
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Remaining To Buy</p>
                <p className={cn("mt-1 text-2xl font-semibold tabular-nums", toneClass)}>
                  {formatCurrency(remainingToBuyCents)}
                </p>
              </div>
              <div className="rounded-lg border bg-card p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Actual</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">
                  {formatCurrency(bucket?.actualCents)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {bucket?.variancePercent ?? 0}% spent
                </p>
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

            {bucket?.costCodeId && (
              <CostCodeProgressEditor
                projectId={projectId}
                costCodeId={bucket.costCodeId}
                percentComplete={bucket.percentComplete}
                estimateRemainingCents={bucket.costToCompleteCents}
              />
            )}

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="text-sm font-semibold">Commitments</h4>
                  <p className="text-xs text-muted-foreground">
                    Subcontracts and POs bought against this cost code.
                  </p>
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
                        <TableHead className="w-[120px] px-4 text-right">Contract</TableHead>
                        <TableHead className="w-[120px] px-4 text-right">Allocated</TableHead>
                        <TableHead className="w-[72px] px-2" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {commitments.map((c) => (
                        <TableRow key={c.id} className="group h-[56px] hover:bg-muted/30">
                          <TableCell className="px-4">
                            <span className="block truncate text-sm font-medium">{c.title}</span>
                            <div className="mt-1 flex items-center gap-2">
                              <CommitmentStatusBadge status={c.status} />
                              <span className="block text-xs text-muted-foreground">
                                {c.matching_line_count} {c.matching_line_count === 1 ? "allocation" : "allocations"}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden px-4 md:table-cell">
                            <span className="block truncate text-xs text-muted-foreground">
                              {c.company_name ?? "No company"}
                            </span>
                          </TableCell>
                          <TableCell className="px-4 text-right">
                            <span className="text-sm tabular-nums text-muted-foreground">
                              {formatCurrency(c.total_cents)}
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
  costCodesEnabled,
  existingBucketKeys,
  onSave,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: CostBucketDraft | null
  costCodes: CostCode[]
  costCodesEnabled: boolean
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
    (!costCodesEnabled || costCodeId === "__uncoded__" || !existingBucketKeys.includes(costCodeId) || draft?.costCodeId === costCodeId)

  const selectedCode = costCodeId === "__uncoded__" ? null : costCodes.find((code) => code.id === costCodeId)

  const submit = () => {
    if (!canSave) return
    onSave({
      key: draft?.key ?? null,
      costCodeId: costCodesEnabled && costCodeId !== "__uncoded__" ? costCodeId : null,
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
              Set the budget amount and scope note for this project budget.
            </SheetDescription>
          </div>

          <div className="space-y-5 pb-6">
            {costCodesEnabled ? (
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
            ) : null}

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

// ---- Commitment dialogs ----

function CommitmentCreateDialog({
  open,
  onOpenChange,
  projectId,
  companies,
  costCodes,
  costCodesEnabled,
  draft,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  companies: Company[]
  costCodes: CostCode[]
  costCodesEnabled: boolean
  draft: CommitmentCreateDraft | null
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [companyId, setCompanyId] = useState<string>(companies[0]?.id ?? "")
  const [costCodeId, setCostCodeId] = useState("")
  const [title, setTitle] = useState("")
  const [scope, setScope] = useState("")
  const [amountDollars, setAmountDollars] = useState("")
  const [status, setStatus] = useState("draft")

  useEffect(() => {
    if (open) {
      setCompanyId(companies[0]?.id ?? "")
      setCostCodeId(costCodesEnabled ? draft?.costCodeId ?? costCodes[0]?.id ?? "" : "")
      setTitle("")
      setScope(draft?.defaultScope ?? "")
      setAmountDollars(draft?.defaultAmountDollars ?? "")
      setStatus("draft")
    }
  }, [open, companies, costCodes, costCodesEnabled, draft])

  const submit = () => {
    if (!companyId) {
      toast({ title: "Company required" })
      return
    }
    if (costCodesEnabled && !costCodeId) {
      toast({ title: "Cost code required" })
      return
    }
    if (title.trim().length < 2) {
      toast({ title: "Title required" })
      return
    }
    const n = Number(amountDollars)
    if (!Number.isFinite(n) || n <= 0) {
      toast({ title: "Invalid amount" })
      return
    }
    if (!scope.trim()) {
      toast({ title: "Scope required" })
      return
    }

    startTransition(async () => {
      try {
        const commitment = await createProjectCommitmentAction(projectId, {
          project_id: projectId,
          company_id: companyId,
          title: title.trim(),
          total_cents: Math.round(n * 100),
          status,
        })
        await createCommitmentLineAction(commitment.id, {
          cost_code_id: costCodesEnabled ? costCodeId : null,
          description: scope.trim(),
          quantity: 1,
          unit: "LS",
          unit_cost_cents: Math.round(n * 100),
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
            Create a subcontract or PO and allocate it to this project budget.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
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
            {costCodesEnabled ? (
              <div className="space-y-1.5">
                <Label>Cost code</Label>
                <Select value={costCodeId} onValueChange={setCostCodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select cost code" />
                  </SelectTrigger>
                  <SelectContent>
                    {costCodes.map((code) => (
                      <SelectItem key={code.id} value={code.id}>
                        {code.code ? `${code.code} — ${code.name}` : code.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g., Plumbing subcontract"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Allocated scope</Label>
            <Input
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="e.g., Rough plumbing labor and trim"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Initial commitment amount ($)</Label>
              <Input
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
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
              <p className="text-xs text-muted-foreground">
                Once allocation lines exist, this total follows the line total.
              </p>
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
  costCodesEnabled,
}: {
  commitment: CommitmentSummary | null
  onClose: () => void
  costCodesEnabled: boolean
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
    Promise.all([listCommitmentLinesAction(commitment.id), costCodesEnabled ? listCostCodesAction() : Promise.resolve([])])
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
  }, [commitment, costCodesEnabled, toast])

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
            Line items with quantities and unit costs.
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
                    {costCodesEnabled ? <TableHead className="px-3">Cost code</TableHead> : null}
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
                      {costCodesEnabled ? (
                        <TableCell className="px-3 font-mono text-xs">
                          {line.cost_code_code ?? "—"}
                        </TableCell>
                      ) : null}
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
                    <TableCell colSpan={costCodesEnabled ? 5 : 4} className="px-3 text-right text-xs uppercase tracking-wide text-muted-foreground">
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
          costCodesEnabled={costCodesEnabled}
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
  costCodesEnabled,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commitmentId: string
  line: CommitmentLine | null
  costCodes: CostCode[]
  costCodesEnabled: boolean
  onSaved: () => void
}) {
  const { toast } = useToast()
  const router = useRouter()
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
    if (costCodesEnabled && !costCodeId) {
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
          cost_code_id: costCodesEnabled ? costCodeId : null,
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
        router.refresh()
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
        router.refresh()
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
          {costCodesEnabled ? (
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
          ) : null}
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

function CostCodeProgressEditor({
  projectId,
  costCodeId,
  percentComplete,
  estimateRemainingCents,
}: {
  projectId: string
  costCodeId: string
  percentComplete: number | null
  estimateRemainingCents: number | null
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const [percent, setPercent] = useState(percentComplete != null ? percentComplete.toString() : "")
  const [ctc, setCtc] = useState(estimateRemainingCents != null ? (estimateRemainingCents / 100).toFixed(2) : "")

  useEffect(() => {
    setPercent(percentComplete != null ? percentComplete.toString() : "")
    setCtc(estimateRemainingCents != null ? (estimateRemainingCents / 100).toFixed(2) : "")
  }, [percentComplete, estimateRemainingCents])

  const submit = () => {
    startTransition(async () => {
      try {
        const p = percent.trim() ? parseFloat(percent) : null
        const c = ctc.trim() ? Math.round(parseFloat(ctc) * 100) : null
        await updateCostCodeProgressAction(projectId, costCodeId, {
          percent_complete: p,
          estimate_remaining_cents: c,
        })
        toast({ title: "Progress updated" })
        router.refresh()
      } catch (error) {
        toast({ title: "Failed to update progress", description: (error as Error).message })
      }
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold">Forecast & Progress</h4>
          <p className="text-xs text-muted-foreground">Update completion percentage and CTC.</p>
        </div>
      </div>
      <div className="rounded-lg border bg-card p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Percent Complete (%)</Label>
            <Input type="number" min="0" max="100" value={percent} onChange={e => setPercent(e.target.value)} placeholder="0-100" />
          </div>
          <div className="space-y-1.5">
            <Label>Cost to Complete (CTC $)</Label>
            <Input type="number" min="0" value={ctc} onChange={e => setCtc(e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={submit} disabled={isPending}>{isPending ? "Saving..." : "Save Forecast"}</Button>
        </div>
      </div>
    </div>
  )
}
