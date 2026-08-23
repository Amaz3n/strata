"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Download,
  History,
  ListOrdered,
  MoreHorizontal,
  LineChart,
  Lock,
  Plus,
  Save,
  Sparkles,
  Upload,
} from "lucide-react"

import type { CostCode } from "@/lib/types"
import type { CommitmentSummary } from "@/lib/services/commitments"
import type { ProjectBuyoutStatus } from "@/lib/services/bids"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import type { ProjectPocResult } from "@/lib/financials/poc-rules"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import type {
  BudgetBreakdownRow,
  BudgetWithActuals,
  VarianceAlert,
} from "@/lib/services/budgets"
import type { BudgetTransfer } from "@/lib/services/budget-transfers"
import type { CostType } from "@/lib/cost-types"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"
import { unwrapAction } from "@/lib/action-result"

import {
  acknowledgeVarianceAlertAction,
  createProjectBudgetAction,
  lockBudgetBaselineAction,
  replaceProjectBudgetLinesAction,
  runVarianceScanAction,
} from "@/app/(app)/projects/[id]/financials/budget/actions"
import {
  fetchBudgetBucketChangeOrdersAction,
  fetchBudgetBucketCommitmentsAction,
} from "@/app/(app)/projects/[id]/financials/actions"

import { Button } from "@/components/ui/button"
import { PoGenerationPanel } from "@/components/purchasing/po-generation-panel"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Input } from "@/components/ui/input"

import { BudgetTransfersPanel } from "@/components/financials/budget-transfers-panel"
import { BudgetMobileCards, BudgetTable } from "./budget-table"
import { BudgetBucketSheet, CostBucketEditorSheet } from "./bucket-sheet"
import { CashFlowDialog } from "./cash-flow-dialog"
import { BudgetChangeLogDialog } from "./change-log-dialog"
import {
  CommitmentCreateDialog,
  CommitmentEditDialog,
  CommitmentFilesDialog,
  CommitmentLinesDialog,
} from "./commitment-dialogs"
import {
  CsvImportDialog,
  EstimateImportDialog,
  SaveBudgetTemplateDialog,
  UnifiedBudgetEmptyState,
} from "./import-dialogs"
import {
  dollarsToCents,
  formatCurrency,
  Hint,
  SummaryMetric,
  toLineState,
  type CommitmentCreateDraft,
  type CostBucketDraft,
  type EditableBudgetLine,
  type UnifiedBudgetRow,
} from "./shared"

/** The slice of the project record the budget tab actually reads. */
export interface BudgetTabProject {
  id: string
  name: string
  start_date?: string | null
  end_date?: string | null
}

interface BudgetTabProps {
  projectId: string
  project: BudgetTabProject
  contractValueCents?: number
  /** Authoritative WIP position from the server. Null when unavailable. */
  poc?: ProjectPocResult | null
  budgetData: BudgetWithActuals | null
  costCodes: CostCode[]
  costCodesEnabled?: boolean
  varianceAlerts: VarianceAlert[]
  budgetBucketCompanies: Record<string, string[]>
  buyoutStatus?: ProjectBuyoutStatus | null
  feeSummary?: ProjectFeeBillingSummary | null
  gmpSummary?: ProjectGmpControlSummary | null
  loadErrors?: string[]
  budgetTransfers?: BudgetTransfer[]
  /** RBAC: whether the viewer holds budget.write. */
  canWrite?: boolean
  /**
   * Production posture: baseline-locked budgets stop taking direct line edits —
   * money moves via transfers and VPOs instead.
   */
  lockAfterBaseline?: boolean
}

// Full-bleed KPI cells matching the project overview stat row. Borders are
// applied per position so the cells read as one continuous strip.
const kpiCellBorders: Record<number, string> = {
  0: "border-b sm:border-r lg:border-b-0 lg:border-r",
  1: "border-b lg:border-b-0 lg:border-r",
  2: "border-b sm:border-r lg:border-b-0 lg:border-r",
  3: "border-b lg:border-b-0 lg:border-r",
  4: "",
}

function KpiCell({
  label,
  value,
  hint,
  sub,
  valueClass,
  position,
}: {
  label: string
  value: string
  hint?: string
  sub?: string
  valueClass?: string
  position: number
}) {
  return (
    <div className={cn("flex flex-col gap-2.5 px-6 py-6 sm:px-8", kpiCellBorders[position])}>
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/80">
        {hint ? <Hint label={label} hint={hint} /> : label}
      </div>
      <div
        className={cn(
          "text-[26px] leading-none font-semibold tracking-tight tabular-nums text-foreground sm:text-[30px]",
          valueClass,
        )}
      >
        {value}
      </div>
      {sub ? <div className="text-xs tabular-nums text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

export function BudgetTab({
  projectId,
  project,
  contractValueCents,
  poc,
  budgetData,
  costCodes,
  costCodesEnabled = true,
  varianceAlerts,
  budgetBucketCompanies,
  buyoutStatus = null,
  feeSummary = null,
  gmpSummary = null,
  loadErrors = [],
  budgetTransfers = [],
  canWrite = true,
  lockAfterBaseline = false,
}: BudgetTabProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const currentBudget = budgetData?.budget ?? null
  const summary = budgetData?.summary ?? null
  const baselineLockedAt: string | null = summary?.baseline_locked_at ?? null
  // Production discipline: after the baseline locks, line amounts only move via
  // transfers and VPOs. Other postures keep the budget a living document.
  const lockedByPosture = lockAfterBaseline && baselineLockedAt !== null
  const editable = canWrite && !lockedByPosture

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
  const [activeBucketChangeOrders, setActiveBucketChangeOrders] = useState<
    Array<{ id: string; title: string; status: string; approved_at: string | null; amount_cents: number }>
  >([])
  const [activeBucketChangeOrdersLoading, setActiveBucketChangeOrdersLoading] = useState(false)
  // Simple view hides the WIP/forecast columns (EAC/VAC/CTC); detailed shows everything.
  const [viewMode, setViewMode] = useState<"simple" | "detailed">("simple")
  const [onlyAttention, setOnlyAttention] = useState(false)
  const [estimateImportOpen, setEstimateImportOpen] = useState(false)
  const [templateImportOpen, setTemplateImportOpen] = useState(false)
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [csvImportOpen, setCsvImportOpen] = useState(false)
  const [cashFlowOpen, setCashFlowOpen] = useState(false)
  const [changeLogOpen, setChangeLogOpen] = useState(false)

  // Restore persisted view preference once on mount.
  useEffect(() => {
    try {
      const storedView = window.localStorage.getItem("budget:viewMode")
      if (storedView === "simple" || storedView === "detailed") setViewMode(storedView)
    } catch {
      /* ignore read failures */
    }
  }, [])

  const changeViewMode = (mode: "simple" | "detailed") => {
    setViewMode(mode)
    try {
      window.localStorage.setItem("budget:viewMode", mode)
    } catch {
      /* ignore persistence failures */
    }
  }

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

  const openEditBucket = (bucket: UnifiedBudgetRow) => {
    setEditingBucketDraft({
      key: bucket.key,
      costCodeId: bucket.costCodeId,
      description: bucket.lines[0]?.description ?? "",
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
      id: line.id,
      cost_code_id: costCodesEnabled ? line.cost_code_id : null,
      description: line.description.trim(),
      amount_cents: dollarsToCents(line.amount_dollars) ?? 0,
      cost_type: line.cost_type,
    }))

    startTransition(async () => {
      try {
        if (!currentBudget) {
          unwrapAction(await createProjectBudgetAction({
            project_id: projectId,
            lines: payloadLines,
          }))
          toast({ title: message })
        } else {
          // updated_at rides along as the optimistic-concurrency token so a
          // concurrent editor's save is rejected instead of silently clobbered.
          unwrapAction(
            await replaceProjectBudgetLinesAction(
              projectId,
              currentBudget.id,
              payloadLines,
              currentBudget.updated_at ?? null,
            ),
          )
          toast({ title: message })
        }
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to save budget", description: (error as Error).message })
        router.refresh()
      }
    })
  }

  const upsertBucket = (draft: CostBucketDraft) => {
    const nextLine: EditableBudgetLine = {
      id: draft.lineIds?.[0] ?? crypto.randomUUID(),
      cost_code_id: costCodesEnabled ? draft.costCodeId : null,
      description: draft.description.trim(),
      amount_dollars: draft.amountDollars.trim() || "0",
      cost_type: draft.costCodeId ? costCodeById.get(draft.costCodeId)?.cost_type ?? null : null,
    }

    const removeIds = new Set(draft.lineIds ?? [])
    const existingLines = lines.filter((line) => removeIds.has(line.id))
    const unchangedLines = lines.filter((line) => !removeIds.has(line.id))
    const targetCents = dollarsToCents(draft.amountDollars) ?? 0

    // Multi-line buckets keep their internal entries (ids are referenced by
    // transfers and commitments) and rescale them proportionally to the new
    // total; the last line absorbs the rounding remainder.
    const currentBucketCents = existingLines.reduce(
      (sum, item) => sum + (dollarsToCents(item.amount_dollars) ?? 0),
      0,
    )
    const replacementLines =
      existingLines.length > 1
        ? (() => {
            let allocated = 0
            return existingLines.map((line, index) => {
              const currentLineCents = dollarsToCents(line.amount_dollars) ?? 0
              const scaledCents =
                currentBucketCents > 0
                  ? Math.round((currentLineCents / currentBucketCents) * targetCents)
                  : index === 0
                    ? targetCents
                    : 0
              const nextLineCents =
                index === existingLines.length - 1 ? Math.max(0, targetCents - allocated) : scaledCents
              allocated += nextLineCents
              return {
                ...line,
                cost_code_id: costCodesEnabled ? draft.costCodeId : null,
                description: index === 0 ? draft.description.trim() : line.description,
                amount_dollars: (nextLineCents / 100).toFixed(2),
              }
            })
          })()
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
      toast({ title: "At least one budget line is required" })
      return
    }
    setLines(nextLines)
    persistBudgetLines(nextLines, "Budget line removed")
  }

  // Inline edit of a single budget line's amount (used by the editable Budget cell).
  const updateLineAmount = (lineId: string, amountDollars: string) => {
    const target = lines.find((line) => line.id === lineId)
    if (!target) return
    const nextCents = dollarsToCents(amountDollars)
    if (nextCents === null || nextCents < 0) {
      toast({ title: "Enter a valid amount" })
      return
    }
    if (nextCents === (dollarsToCents(target.amount_dollars) ?? 0)) return // no change
    const nextLines = lines.map((line) =>
      line.id === lineId ? { ...line, amount_dollars: (nextCents / 100).toFixed(2) } : line,
    )
    setLines(nextLines)
    persistBudgetLines(nextLines, "Budget updated")
  }

  const acknowledgeAll = () => {
    startTransition(async () => {
      try {
        await Promise.all(activeAlerts.map((alert) => acknowledgeVarianceAlertAction(projectId, alert.id, "acknowledged").then(unwrapAction)))
        toast({ title: "Alerts acknowledged" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to update alerts", description: (error as Error).message })
      }
    })
  }

  const runScan = () =>
    startTransition(async () => {
      try {
        unwrapAction(await runVarianceScanAction(projectId))
        toast({ title: "Variance scan complete" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to run variance scan", description: (error as Error).message })
      }
    })

  // ---------- Summary computations ----------
  const activeAlerts = (varianceAlerts ?? []).filter((a) => a.status === "active")

  const [createOpen, setCreateOpen] = useState(false)
  const [createCommitmentDraft, setCreateCommitmentDraft] =
    useState<CommitmentCreateDraft | null>(null)
  const [editCommitment, setEditCommitment] = useState<CommitmentSummary | null>(null)
  const [linesCommitment, setLinesCommitment] = useState<CommitmentSummary | null>(null)
  const [filesCommitment, setFilesCommitment] = useState<CommitmentSummary | null>(null)
  const [signatureCommitment, setSignatureCommitment] = useState<CommitmentSummary | null>(null)

  const breakdownByCostCode = useMemo(() => {
    const map = new Map<string, BudgetBreakdownRow>()
    for (const row of budgetData?.breakdown ?? []) {
      const key = (costCodesEnabled ? row.cost_code_id : row.budget_line_id) ?? "uncoded"
      map.set(key, row)
    }
    return map
  }, [budgetData?.breakdown, costCodesEnabled])

  const unifiedRows = useMemo(() => {
    const grouped = new Map<string, UnifiedBudgetRow>()

    for (const line of lines) {
      const lineCostCodeId = costCodesEnabled ? line.cost_code_id : null
      // Codes on: group lines that share a cost code. Codes off: every budget
      // line is its own bucket (keyed by its row id) so they never collapse.
      const key = costCodesEnabled ? lineCostCodeId ?? "uncoded" : line.id
      const code = lineCostCodeId ? costCodeById.get(lineCostCodeId) : null
      const breakdown = breakdownByCostCode.get(key)
      const fallbackName = costCodesEnabled
        ? "Uncoded"
        : line.description.trim() || "Untitled line"
      const existing = grouped.get(key) ?? {
        key,
        costCodeId: lineCostCodeId,
        code: code?.code,
        name: code?.name ?? fallbackName,
        category: code?.category ?? null,
        costType: (line.cost_type ?? code?.cost_type ?? breakdown?.cost_type ?? null) as CostType | null,
        lines: [] as EditableBudgetLine[],
        budgetCents: 0,
        baselineCents: breakdown?.baseline_cents ?? null,
        coAdjustmentCents: breakdown?.co_adjustment_cents ?? 0,
        adjustedBudgetCents: breakdown?.adjusted_budget_cents ?? 0,
        committedCents: breakdown?.committed_cents ?? 0,
        committedBilledCents: breakdown?.committed_billed_cents ?? 0,
        remainingCommitmentCents: breakdown?.remaining_commitment_cents ?? 0,
        pendingCostCents: breakdown?.pending_cost_cents ?? 0,
        exposureCents: breakdown?.exposure_cents ?? breakdown?.actual_cents ?? 0,
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
        buyout: costCodesEnabled
          ? lineCostCodeId
            ? buyoutStatus?.by_cost_code_id[lineCostCodeId] ?? null
            : null
          : buyoutStatus?.by_budget_line_id[line.id] ?? null,
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
        name: code?.name ?? (costCodesEnabled ? "Uncoded" : "Unassigned"),
        category: code?.category ?? null,
        costType: (code?.cost_type ?? breakdown.cost_type ?? null) as CostType | null,
        lines: [] as EditableBudgetLine[],
        budgetCents: breakdown.budget_cents ?? 0,
        baselineCents: breakdown.baseline_cents ?? null,
        coAdjustmentCents: breakdown.co_adjustment_cents ?? 0,
        adjustedBudgetCents: breakdown.adjusted_budget_cents ?? 0,
        committedCents: breakdown.committed_cents ?? 0,
        committedBilledCents: breakdown.committed_billed_cents ?? 0,
        remainingCommitmentCents: breakdown.remaining_commitment_cents ?? 0,
        pendingCostCents: breakdown.pending_cost_cents ?? 0,
        exposureCents: breakdown.exposure_cents ?? breakdown.actual_cents ?? 0,
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
        buyout: breakdownCostCodeId
          ? buyoutStatus?.by_cost_code_id[breakdownCostCodeId] ?? null
          : buyoutStatus?.by_budget_line_id[key] ?? null,
      })
    }

    return Array.from(grouped.values()).sort((a, b) => {
      const codeA = a.code ?? "zzz"
      const codeB = b.code ?? "zzz"
      return codeA.localeCompare(codeB) || a.name.localeCompare(b.name)
    })
  }, [breakdownByCostCode, budgetBucketCompanies, buyoutStatus, costCodeById, costCodesEnabled, lines])

  const attentionCount = useMemo(
    () => unifiedRows.filter((row) => row.status === "over" || row.status === "warning").length,
    [unifiedRows],
  )
  const hasCostTypes = useMemo(
    () => unifiedRows.some((row) => row.costType !== null),
    [unifiedRows],
  )

  const filteredUnifiedRows = useMemo(() => {
    const term = budgetLineSearch.trim().toLowerCase()
    let rows = unifiedRows
    if (onlyAttention) {
      rows = rows.filter((row) => row.status === "over" || row.status === "warning")
    }
    if (!term) return rows
    return rows.filter((row) =>
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
  }, [budgetLineSearch, onlyAttention, unifiedRows])

  // Exports the FULL budget regardless of any active search/attention filter —
  // a filtered file silently posing as the whole budget has burned people before.
  const exportBudgetCsv = () => {
    const headers = [
      ...(costCodesEnabled ? ["Code"] : []),
      "Budget line",
      "Budget",
      "Approved CO",
      "Revised",
      "Committed",
      "Exposure",
      "Spent",
      "Left to spend",
      "EAC",
      "% spent",
    ]
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
    const toAmount = (cents: number) => (cents / 100).toFixed(2)
    const rows = unifiedRows.map((row) =>
      [
        ...(costCodesEnabled ? [row.code ?? "Uncoded"] : []),
        row.name,
        toAmount(row.budgetCents),
        toAmount(row.coAdjustmentCents),
        toAmount(row.adjustedBudgetCents),
        toAmount(row.committedCents),
        toAmount(row.exposureCents),
        toAmount(row.actualCents),
        toAmount(row.adjustedBudgetCents - row.actualCents),
        toAmount(row.eacCents),
        String(row.variancePercent ?? 0),
      ]
        .map((cell) => escape(String(cell)))
        .join(","),
    )
    const csv = [headers.map(escape).join(","), ...rows].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    const safeName = (project?.name ?? "project").replace(/[^a-z0-9]+/gi, "-").toLowerCase()
    anchor.download = `${safeName}-budget.csv`
    anchor.click()
    URL.revokeObjectURL(url)
    toast({ title: "Budget exported" })
  }

  const activeBucket = unifiedRows.find((row) => row.key === activeBucketKey) ?? null

  const openCreateCommitment = (bucket?: UnifiedBudgetRow | null) => {
    const remainingToBuyCents = bucket
      ? Math.max(0, bucket.adjustedBudgetCents - bucket.committedCents)
      : 0

    // Codes off: tie the commitment to the originating budget line (bucket key
    // is the budget_line id) so its contract amount rolls into that line.
    const budgetLineId =
      !costCodesEnabled && bucket?.key && bucket.key !== "uncoded" ? bucket.key : null

    setCreateCommitmentDraft({
      costCodeId: costCodesEnabled ? bucket?.costCodeId ?? null : null,
      budgetLineId,
      defaultAmountDollars:
        remainingToBuyCents > 0 ? (remainingToBuyCents / 100).toFixed(2) : "",
      defaultScope: bucket?.lines[0]?.description?.trim() || "",
    })
    setCreateOpen(true)
  }

  const startBidPackage = (bucket?: UnifiedBudgetRow | null) => {
    const remainingToBuyCents = bucket
      ? Math.max(0, bucket.adjustedBudgetCents - bucket.committedCents)
      : 0
    const budgetLineId =
      bucket?.lines.length === 1
        ? bucket.lines[0].id
        : !costCodesEnabled && bucket?.key && bucket.key !== "uncoded"
          ? bucket.key
          : null
    const params = new URLSearchParams()
    if (bucket?.costCodeId) params.set("cost_code_id", bucket.costCodeId)
    if (budgetLineId) params.set("budget_line_id", budgetLineId)
    if (remainingToBuyCents > 0) params.set("amount_cents", String(remainingToBuyCents))
    if (bucket?.name) params.set("title", bucket.name)
    const scope = bucket?.lines[0]?.description?.trim()
    if (scope) params.set("scope", scope)
    const query = params.toString()
    router.push(`/projects/${projectId}/bids${query ? `?${query}` : ""}`)
  }

  useEffect(() => {
    if (!activeBucket) {
      setActiveBucketCommitments([])
      return
    }

    let cancelled = false
    setActiveBucketCommitmentsLoading(true)
    fetchBudgetBucketCommitmentsAction(
      projectId,
      costCodesEnabled ? activeBucket.costCodeId : activeBucket.key,
      costCodesEnabled ? "cost_code" : "budget_line",
    )
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

  // Load the change orders that adjusted the active bucket.
  useEffect(() => {
    if (!activeBucket || activeBucket.coAdjustmentCents === 0) {
      setActiveBucketChangeOrders([])
      return
    }
    const bucketCoKey = costCodesEnabled ? activeBucket.costCodeId : activeBucket.key
    if (!bucketCoKey) {
      setActiveBucketChangeOrders([])
      return
    }
    let cancelled = false
    setActiveBucketChangeOrdersLoading(true)
    fetchBudgetBucketChangeOrdersAction(
      projectId,
      bucketCoKey,
      costCodesEnabled ? "cost_code" : "budget_line",
    )
      .then((rows) => {
        if (!cancelled) setActiveBucketChangeOrders(rows)
      })
      .catch(() => {
        if (!cancelled) setActiveBucketChangeOrders([])
      })
      .finally(() => {
        if (!cancelled) setActiveBucketChangeOrdersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeBucket, costCodesEnabled, projectId])

  // ---------- Render ----------
  // The real contract total comes from the project's contract record (passed in
  // as contractValueCents). The WIP numbers come from the server's
  // percentage-of-completion resolver — the same one behind the snapshot and
  // the WIP over/under report — so this band can never contradict them.
  const contractValue = poc?.revisedContractCents ?? contractValueCents ?? 0
  const contractBilled = poc?.billedCents ?? null
  const earnedRevenue = poc?.earnedRevenueCents ?? null
  const overUnderBilling = poc?.overUnderCents ?? null
  const showFeeSummary = feeSummary?.enabled || feeSummary?.billing_model === "cost_plus_fixed_fee"

  const isDetailed = viewMode === "detailed"

  // Projected margin: what the job makes if the forecast holds. THE number this
  // page exists to answer — contract minus estimate-at-completion.
  const totalEac = summary?.total_eac_cents ?? null
  const projectedMargin = totalEac !== null && contractValue > 0 ? contractValue - totalEac : null
  const projectedMarginPercent =
    projectedMargin !== null && contractValue > 0 ? Math.round((projectedMargin / contractValue) * 100) : null

  const lockBaseline = () =>
    startTransition(async () => {
      try {
        unwrapAction(await lockBudgetBaselineAction(projectId))
        toast({ title: baselineLockedAt ? "Baseline updated" : "Baseline locked" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to lock baseline", description: (error as Error).message })
      }
    })

  const emptyState = (
    <UnifiedBudgetEmptyState
      editable={editable}
      onCreate={openCreateBucket}
      onEstimateImport={() => setEstimateImportOpen(true)}
      onTemplateImport={() => setTemplateImportOpen(true)}
      filtered={onlyAttention || budgetLineSearch.trim().length > 0}
    />
  )

  return (
    <div className="-mx-4 -mt-6 -mb-4 flex flex-col bg-card">
      {loadErrors.length > 0 && <FinancialLoadWarning errors={loadErrors} />}
      <PoGenerationPanel projectId={projectId} />
      {activeAlerts.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warning/40 bg-warning/5 px-6 py-2.5 text-sm">
          <div className="flex items-center gap-2 font-medium text-warning">
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
              onClick={acknowledgeAll}
            >
              Ack all
            </Button>
          </div>
        </div>
      )}

      {/* Cost-control KPIs — the page's own numbers, headed by projected margin. */}
      <div className="grid grid-cols-1 border-b sm:grid-cols-2 lg:grid-cols-5">
        <KpiCell label="Contract Value" value={formatCurrency(contractValue)} position={0} />
        <KpiCell
          label="Revised Budget"
          hint="Original budget plus approved change orders."
          value={formatCurrency(summary?.adjusted_budget_cents)}
          position={1}
        />
        <KpiCell
          label="Committed"
          hint="Locked in via approved subcontracts and purchase orders."
          value={formatCurrency(summary?.total_committed_cents)}
          position={2}
        />
        <KpiCell
          label="EAC"
          hint="Estimate at Completion — projected total project cost when finished."
          value={formatCurrency(summary?.total_eac_cents)}
          position={3}
        />
        <KpiCell
          label="Projected Margin"
          hint="Contract value minus EAC — what the job makes if the forecast holds."
          value={projectedMargin === null ? "—" : formatCurrency(projectedMargin)}
          sub={projectedMarginPercent === null ? undefined : `${projectedMarginPercent}% of contract`}
          valueClass={cn(
            projectedMargin !== null && projectedMargin < 0
              ? "text-destructive"
              : projectedMargin !== null
                ? "text-success"
                : "",
          )}
          position={4}
        />
      </div>

      {/* Secondary WIP band from the POC resolver — earned vs billed position. */}
      {poc && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b bg-muted/20 px-6 py-2 text-xs tabular-nums text-muted-foreground">
          <span className="font-medium uppercase tracking-wide text-muted-foreground/80">WIP</span>
          <span>
            Earned <span className="font-medium text-foreground">{earnedRevenue === null ? "—" : formatCurrency(earnedRevenue)}</span>
          </span>
          <span>
            Billed <span className="font-medium text-foreground">{contractBilled === null ? "—" : formatCurrency(contractBilled)}</span>
          </span>
          <span>
            Over/(Under){" "}
            <span
              className={cn(
                "font-medium",
                overUnderBilling !== null && overUnderBilling > 0
                  ? "text-success"
                  : overUnderBilling !== null && overUnderBilling < 0
                    ? "text-destructive"
                    : "text-foreground",
              )}
            >
              {overUnderBilling === null ? "—" : formatCurrency(overUnderBilling)}
            </span>
          </span>
        </div>
      )}

      {showFeeSummary || gmpSummary?.enabled ? (
        <div className="divide-y border-b">
          {showFeeSummary ? (
            <div className="px-6 py-4">
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
              <div className="border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
                {feeSummary?.reason ?? "Fixed-fee billing setup is incomplete."}
              </div>
            )}
          </div>
        ) : null}
          {gmpSummary?.enabled ? (
            <div className="px-6 py-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">GMP Control</div>
              <span
                className={cn(
                  "px-2 py-1 text-[11px] font-medium uppercase",
                  gmpSummary.status === "overrun"
                    ? "bg-destructive/10 text-destructive"
                    : gmpSummary.status === "watch"
                      ? "bg-warning/10 text-warning"
                      : "bg-success/10 text-success",
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
                          ? "border-warning/40 bg-warning/10 text-warning"
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
      ) : null}

      {/* Sticky controls bar - sits flush below the tab bar when scrolled */}
      <div className="sticky top-11 z-[5] flex items-center gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <Input
          placeholder="Search by code, line, or scope..."
          className="h-9 flex-1 sm:max-w-xs"
          value={budgetLineSearch}
          onChange={(event) => setBudgetLineSearch(event.target.value)}
        />
        {/* Simple / Detailed segmented control */}
        <div className="hidden h-9 items-center border p-0.5 sm:flex">
          {(["simple", "detailed"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => changeViewMode(mode)}
              className={cn(
                "flex h-full items-center px-2.5 text-xs font-medium capitalize transition-colors",
                viewMode === mode
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        {(attentionCount > 0 || onlyAttention) && (
          <Button
            variant={onlyAttention ? "default" : "outline"}
            size="sm"
            className="h-9 gap-1.5"
            onClick={() => setOnlyAttention((prev) => !prev)}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            <span className="tabular-nums">{attentionCount}</span>
            <span className="hidden sm:inline">need attention</span>
          </Button>
        )}
        {lockedByPosture ? (
          <span
            className="hidden items-center gap-1.5 border border-warning/40 bg-warning/10 px-2 py-1 text-xs text-warning lg:inline-flex"
            title="Production budgets lock at baseline. Move money with budget transfers or VPOs."
          >
            <Lock className="h-3 w-3" />
            Locked at baseline — use transfers &amp; VPOs
          </span>
        ) : baselineLockedAt ? (
          <span
            className="hidden items-center gap-1.5 border px-2 py-1 text-xs text-muted-foreground lg:inline-flex"
            title={`Baseline locked ${new Date(baselineLockedAt).toLocaleString()}`}
          >
            <Lock className="h-3 w-3" />
            Baseline {new Date(baselineLockedAt).toLocaleDateString()}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          {editable && (
            <Button size="sm" onClick={openCreateBucket}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Add line</span>
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
              {editable && (
                <>
                  <DropdownMenuItem onClick={() => setEstimateImportOpen(true)}>
                    <Sparkles className="h-4 w-4" />
                    Start from estimate
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTemplateImportOpen(true)}>
                    <ListOrdered className="h-4 w-4" />
                    Start from template
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem onClick={() => setSaveTemplateOpen(true)} disabled={unifiedRows.length === 0}>
                <Save className="h-4 w-4" />
                Save as template
              </DropdownMenuItem>
              {editable && (
                <DropdownMenuItem onClick={() => setCsvImportOpen(true)}>
                  <Upload className="h-4 w-4" />
                  Import CSV
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={exportBudgetCsv} disabled={unifiedRows.length === 0}>
                <Download className="h-4 w-4" />
                Export CSV
              </DropdownMenuItem>
              {canWrite && (
                <DropdownMenuItem onClick={lockBaseline} disabled={isPending || unifiedRows.length === 0}>
                  <Lock className="h-4 w-4" />
                  {baselineLockedAt ? "Re-baseline budget" : "Lock budget baseline"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setChangeLogOpen(true)} disabled={!currentBudget}>
                <History className="h-4 w-4" />
                Change history
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCashFlowOpen(true)} disabled={unifiedRows.length === 0}>
                <LineChart className="h-4 w-4" />
                Cash flow forecast
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <BudgetMobileCards
        rows={filteredUnifiedRows}
        costCodesEnabled={costCodesEnabled}
        onOpenBucket={setActiveBucketKey}
        emptyState={emptyState}
      />

      <BudgetTable
        rows={filteredUnifiedRows}
        costCodesEnabled={costCodesEnabled}
        isDetailed={isDetailed}
        hasCostTypes={hasCostTypes}
        editable={editable}
        onOpenBucket={setActiveBucketKey}
        onEditAmount={updateLineAmount}
        onCreateCommitment={openCreateCommitment}
        onStartBidPackage={startBidPackage}
        emptyState={emptyState}
      />

      <BudgetTransfersPanel
        projectId={projectId}
        transfers={budgetTransfers}
        lines={(currentBudget?.lines ?? []).map((line) => {
          const costCode = Array.isArray(line.cost_code) ? line.cost_code[0] : line.cost_code
          const actualCents = (budgetData?.breakdown ?? [])
            .filter(
              (row) =>
                row.budget_line_id === line.id ||
                (line.cost_code_id != null && row.cost_code_id === line.cost_code_id),
            )
            .reduce((sum, row) => sum + Number(row.actual_cents ?? 0), 0)
          return {
            id: line.id,
            description: line.description,
            amount_cents: line.amount_cents,
            metadata: line.metadata ?? {},
            cost_code: costCode,
            actual_cents: actualCents,
          }
        })}
      />

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
        changeOrders={activeBucketChangeOrders}
        changeOrdersLoading={activeBucketChangeOrdersLoading}
        alerts={activeAlerts}
        costCodesEnabled={costCodesEnabled}
        editable={editable}
        onEditBucket={() => activeBucket && openEditBucket(activeBucket)}
        onCreateCommitment={() => openCreateCommitment(activeBucket)}
        onStartBidPackage={() => startBidPackage(activeBucket)}
        onEditCommitment={(commitment) => setEditCommitment(commitment)}
        onCommitmentLines={(commitment) => setLinesCommitment(commitment)}
        onCommitmentFiles={(commitment) => setFilesCommitment(commitment)}
        onCommitmentSignature={(commitment) => setSignatureCommitment(commitment)}
      />
      <CommitmentCreateDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open)
          if (!open) setCreateCommitmentDraft(null)
        }}
        projectId={projectId}
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
        projectId={projectId}
        onClose={() => setLinesCommitment(null)}
        costCodesEnabled={costCodesEnabled}
        defaultBudgetLineId={!costCodesEnabled && activeBucket?.key !== "uncoded" ? activeBucket?.key ?? null : null}
      />
      <CommitmentFilesDialog
        commitment={filesCommitment}
        projectId={projectId}
        onClose={() => setFilesCommitment(null)}
      />
      <EnvelopeWizard
        open={signatureCommitment !== null}
        onOpenChange={(open) => {
          if (!open) setSignatureCommitment(null)
        }}
        sourceEntity={
          signatureCommitment
            ? ({
                type: "subcontract",
                id: signatureCommitment.id,
                project_id: signatureCommitment.project_id,
                title: signatureCommitment.title,
                document_type: "contract",
              } satisfies EnvelopeWizardSourceEntity)
            : null
        }
        sourceLabel="Commitment"
        sheetTitle="Send commitment for signature"
        sheetDescription="Upload the subcontract or PO and send it to the vendor/sub for execution."
        onEnvelopeSent={() => {
          setSignatureCommitment(null)
          router.refresh()
        }}
      />
      <EstimateImportDialog
        open={estimateImportOpen}
        onOpenChange={setEstimateImportOpen}
        projectId={projectId}
        hasExistingBudget={lines.length > 0}
        costCodesEnabled={costCodesEnabled}
      />
      <EstimateImportDialog
        sourceKind="template"
        open={templateImportOpen}
        onOpenChange={setTemplateImportOpen}
        projectId={projectId}
        hasExistingBudget={lines.length > 0}
        costCodesEnabled={costCodesEnabled}
      />
      <SaveBudgetTemplateDialog
        open={saveTemplateOpen}
        onOpenChange={setSaveTemplateOpen}
        projectId={projectId}
      />
      <CsvImportDialog
        open={csvImportOpen}
        onOpenChange={setCsvImportOpen}
        projectId={projectId}
        hasExistingBudget={lines.length > 0}
        costCodesEnabled={costCodesEnabled}
        costCodes={costCodeOptions}
      />
      <BudgetChangeLogDialog
        open={changeLogOpen}
        onOpenChange={setChangeLogOpen}
        projectId={projectId}
      />
      <CashFlowDialog
        open={cashFlowOpen}
        onOpenChange={setCashFlowOpen}
        startDate={project?.start_date ?? null}
        endDate={project?.end_date ?? null}
        remainingCostCents={summary?.total_ctc_cents ?? 0}
        contractValueCents={contractValue}
        contractBilledCents={contractBilled ?? 0}
      />
    </div>
  )
}

function FinancialLoadWarning({ errors }: { errors: string[] }) {
  return (
    <div className="border-b border-warning/40 bg-warning/10 px-6 py-3 text-sm text-warning">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">Some financial data could not load.</span>
          <span className="opacity-40">•</span>
          <span>{errors.join(" · ")}</span>
        </div>
      </div>
    </div>
  )
}
