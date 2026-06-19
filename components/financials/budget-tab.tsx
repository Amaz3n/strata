"use client"

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  AlertTriangle,
  Download,
  Info,
  ListOrdered,
  MoreHorizontal,
  LineChart,
  Lock,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react"

import type { CostCode, Company } from "@/lib/types"
import type { CommitmentSummary, CommitmentLine } from "@/lib/services/commitments"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import type { ProjectGmpControlSummary } from "@/lib/services/gmp-control"
import { cn } from "@/lib/utils"
import { useToast } from "@/hooks/use-toast"

import {
  acknowledgeVarianceAlertAction,
  applyBudgetFromEstimateAction,
  createProjectBudgetAction,
  lockBudgetBaselineAction,
  listBudgetEstimateSourcesAction,
  proposeBudgetFromEstimateAction,
  replaceProjectBudgetLinesAction,
  runVarianceScanAction,
  updateCostCodeProgressAction,
} from "@/app/(app)/projects/[id]/budget/actions"
import {
  fetchBudgetBucketChangeOrdersAction,
  fetchBudgetBucketCommitmentsAction,
} from "@/app/(app)/projects/[id]/financials/actions"
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
import { EnvelopeWizard, type EnvelopeWizardSourceEntity } from "@/components/esign/envelope-wizard"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
  budgetLineId: string | null
  defaultAmountDollars: string
  defaultScope: string
}

interface BudgetTabProps {
  projectId: string
  project: any // Project
  contractValueCents?: number
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

/** A label with an info icon that reveals a plain-language definition on hover. */
function Hint({ label, hint, className }: { label: string; hint: string; className?: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex items-center gap-1", className)}>
            {label}
            <Info className="h-3 w-3 opacity-50" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[220px] text-xs font-normal normal-case">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function SummaryMetric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border p-3">
      <span className="text-[11px] font-medium uppercase text-muted-foreground">
        {hint ? <Hint label={label} hint={hint} /> : label}
      </span>
      <span className="font-mono text-sm">{value}</span>
    </div>
  )
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
      className="ml-auto rounded px-1.5 py-0.5 text-sm font-medium tabular-nums hover:bg-muted hover:ring-1 hover:ring-border"
      title="Click to edit"
    >
      {formatCurrency(cents)}
    </button>
  )
}

function KpiCell({
  label,
  value,
  hint,
  valueClass,
  position,
}: {
  label: string
  value: string
  hint?: string
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
  contractValueCents,
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
  // Simple view hides the WIP/forecast columns (EAC/VAC/CTC); detailed shows everything.
  const [viewMode, setViewMode] = useState<"simple" | "detailed">("simple")
  const [onlyAttention, setOnlyAttention] = useState(false)
  const [estimateImportOpen, setEstimateImportOpen] = useState(false)
  const [csvImportOpen, setCsvImportOpen] = useState(false)
  const [cashFlowOpen, setCashFlowOpen] = useState(false)

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
  const [signatureCommitment, setSignatureCommitment] = useState<CommitmentSummary | null>(null)

  const breakdownByCostCode = useMemo(() => {
    const map = new Map<string, any>()
    for (const row of budgetData?.breakdown ?? []) {
      const key = (costCodesEnabled ? row.cost_code_id : row.budget_line_id) ?? "uncoded"
      map.set(key, row)
    }
    return map
  }, [budgetData?.breakdown, costCodesEnabled])

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
        baselineCents: number | null
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
        lines: [] as EditableBudgetLine[],
        budgetCents: 0,
        baselineCents: breakdown?.baseline_cents ?? null,
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
        name: code?.name ?? (costCodesEnabled ? "Uncoded" : "Unassigned"),
        category: code?.category ?? null,
        lines: [] as EditableBudgetLine[],
        budgetCents: breakdown.budget_cents ?? 0,
        baselineCents: breakdown.baseline_cents ?? null,
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

  const attentionCount = useMemo(
    () => unifiedRows.filter((row) => row.status === "over" || row.status === "warning").length,
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

  // Column totals for the table footer — reconciles rows to the KPI strip.
  const columnTotals = useMemo(() => {
    return filteredUnifiedRows.reduce(
      (acc, row) => {
        acc.budgetCents += row.budgetCents
        acc.baselineCents += row.baselineCents ?? row.budgetCents
        acc.coAdjustmentCents += row.coAdjustmentCents
        acc.adjustedBudgetCents += row.adjustedBudgetCents
        acc.committedCents += row.committedCents
        acc.actualCents += row.actualCents
        acc.costToCompleteCents += row.costToCompleteCents
        acc.eacCents += row.eacCents
        acc.varianceAtCompletionCents += row.varianceAtCompletionCents
        acc.remainingToBuyCents += Math.max(0, row.budgetCents - row.committedCents)
        acc.leftToSpendCents += row.adjustedBudgetCents - row.actualCents
        return acc
      },
      {
        budgetCents: 0,
        baselineCents: 0,
        coAdjustmentCents: 0,
        adjustedBudgetCents: 0,
        committedCents: 0,
        actualCents: 0,
        costToCompleteCents: 0,
        eacCents: 0,
        varianceAtCompletionCents: 0,
        remainingToBuyCents: 0,
        leftToSpendCents: 0,
      },
    )
  }, [filteredUnifiedRows])

  const exportBudgetCsv = () => {
    const headers = [
      ...(costCodesEnabled ? ["Code"] : []),
      "Budget line",
      "Budget",
      "Approved CO",
      "Revised",
      "Committed",
      "Spent",
      "Left to spend",
      "EAC",
      "% spent",
    ]
    const escape = (value: string) => `"${value.replaceAll('"', '""')}"`
    const toAmount = (cents: number) => (cents / 100).toFixed(2)
    const rows = filteredUnifiedRows.map((row) =>
      [
        ...(costCodesEnabled ? [row.code ?? "Uncoded"] : []),
        row.name,
        toAmount(row.budgetCents),
        toAmount(row.coAdjustmentCents),
        toAmount(row.adjustedBudgetCents),
        toAmount(row.committedCents),
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

  const openCreateCommitment = (bucket?: {
    key?: string
    costCodeId: string | null
    budgetCents: number
    committedCents: number
    lines: EditableBudgetLine[]
  } | null) => {
    const remainingToBuyCents = bucket
      ? Math.max(0, bucket.budgetCents - bucket.committedCents)
      : 0

    // Codes off: tie the commitment to the originating budget line (bucket key
    // is the budget_line id) so its contract amount rolls into that line.
    const budgetLineId =
      !costCodesEnabled && bucket?.key && bucket.key !== "uncoded" ? bucket.key : null

    setCreateCommitmentDraft({
      costCodeId: costCodesEnabled ? bucket?.costCodeId ?? costCodeOptions[0]?.id ?? null : null,
      budgetLineId,
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

  // ---------- Render ----------
  // The real contract total comes from the project's contract record (passed in
  // as contractValueCents). Fall back to legacy project fields, then 0.
  const contractValue =
    contractValueCents ??
    project?.billing_contract?.total_cents ??
    project?.total_contract_value_cents ??
    0
  const contractBilled = summary?.total_invoiced_cents ?? 0
  const percentComplete = summary?.total_eac_cents > 0 ? (summary?.total_actual_cents ?? 0) / summary.total_eac_cents : 0
  const earnedRevenue = Math.round(contractValue * percentComplete)
  const overUnderBilling = contractBilled - earnedRevenue
  const showFeeSummary = feeSummary?.enabled || feeSummary?.billing_model === "cost_plus_fixed_fee"

  const isDetailed = viewMode === "detailed"
  // Column count for the empty-state colSpan: code? + name + budget + committed +
  // spent + (simple: left,%spent | detailed: original,co,ctc,eac,vac,%comp) + actions.
  const tableColCount =
    (costCodesEnabled ? 1 : 0) + 4 + (isDetailed ? 6 : 2) + 1

  const baselineLockedAt: string | null = summary?.baseline_locked_at ?? null

  const lockBaseline = () =>
    startTransition(async () => {
      try {
        await lockBudgetBaselineAction(projectId)
        toast({ title: baselineLockedAt ? "Baseline updated" : "Baseline locked" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to lock baseline", description: (error as Error).message })
      }
    })

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

      {/* Project WIP & Forecast — full-bleed KPIs */}
      <div className="grid grid-cols-1 border-b sm:grid-cols-2 lg:grid-cols-5">
        <KpiCell label="Contract Value" value={formatCurrency(contractValue)} position={0} />
        <KpiCell
          label="Earned Rev"
          hint="Earned revenue — contract value times percent complete. What you've actually earned so far."
          value={formatCurrency(earnedRevenue)}
          position={1}
        />
        <KpiCell label="Billed Rev" value={formatCurrency(contractBilled)} position={2} />
        <KpiCell
          label="Over/(Under)"
          hint="Over/under billing — billed revenue minus earned revenue. Positive means you've billed ahead of work completed."
          value={formatCurrency(overUnderBilling)}
          valueClass={cn(
            overUnderBilling > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : overUnderBilling < 0
                ? "text-destructive"
                : "",
          )}
          position={3}
        />
        <KpiCell
          label="EAC"
          hint="Estimate at Completion — projected total project cost when finished."
          value={formatCurrency(summary?.total_eac_cents)}
          position={4}
        />
      </div>

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
              <div className="border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
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
        <div className="hidden h-9 items-center rounded-md border p-0.5 sm:flex">
          {(["simple", "detailed"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => changeViewMode(mode)}
              className={cn(
                "flex h-full items-center rounded px-2.5 text-xs font-medium capitalize transition-colors",
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
        {baselineLockedAt && (
          <span
            className="hidden items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground lg:inline-flex"
            title={`Baseline locked ${new Date(baselineLockedAt).toLocaleString()}`}
          >
            <Lock className="h-3 w-3" />
            Baseline {new Date(baselineLockedAt).toLocaleDateString()}
          </span>
        )}
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
              <DropdownMenuItem disabled className="justify-between gap-3">
                <span className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4" />
                  Start from estimate
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Coming soon
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCsvImportOpen(true)}>
                <Upload className="h-4 w-4" />
                Import CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportBudgetCsv} disabled={unifiedRows.length === 0}>
                <Download className="h-4 w-4" />
                Export CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={lockBaseline} disabled={isPending || unifiedRows.length === 0}>
                <Lock className="h-4 w-4" />
                {baselineLockedAt ? "Re-baseline budget" : "Lock budget baseline"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCashFlowOpen(true)} disabled={unifiedRows.length === 0}>
                <LineChart className="h-4 w-4" />
                Cash flow forecast
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Mobile cards */}
      <div className="border-t md:hidden">
        {filteredUnifiedRows.length === 0 ? (
          <div className="px-4 py-12">
            <UnifiedBudgetEmptyState
              editable={editable}
              onCreate={openCreateBucket}
              filtered={onlyAttention || budgetLineSearch.trim().length > 0}
            />
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
                          {costCodesEnabled && (
                            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium">
                              {row.code ?? "Uncoded"}
                            </span>
                          )}
                          {row.status === "over" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
                          )}
                          {row.status === "warning" && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
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
        <Table className="w-full min-w-[820px]">
          <TableHeader>
            <TableRow className="border-b bg-muted/30 hover:bg-muted/30">
              {costCodesEnabled && (
                <TableHead className="w-[120px] px-4 text-xs uppercase tracking-wide">Code</TableHead>
              )}
              <TableHead className="min-w-[200px] px-4 text-xs uppercase tracking-wide">
                {costCodesEnabled ? "Scope" : "Budget line"}
              </TableHead>
              {isDetailed && (
                <>
                  <TableHead className="hidden xl:table-cell w-[110px] px-4 text-right text-xs uppercase tracking-wide">Original</TableHead>
                  <TableHead className="hidden xl:table-cell w-[110px] px-4 text-right text-xs uppercase tracking-wide">Approved CO</TableHead>
                </>
              )}
              <TableHead className="w-[120px] px-4 text-right text-xs uppercase tracking-wide">
                {isDetailed ? "Revised" : "Budget"}
              </TableHead>
              <TableHead className="w-[110px] px-4 text-right text-xs uppercase tracking-wide">
                <Hint className="justify-end" label="Committed" hint="Committed — amount locked in via approved subcontracts and purchase orders for this line." />
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
                    <Hint className="justify-end" label="Left" hint="Left to spend — budget minus what you've spent so far." />
                  </TableHead>
                  <TableHead className="w-[90px] px-4 text-right text-xs uppercase tracking-wide">% spent</TableHead>
                </>
              )}
              <TableHead className="w-[56px] px-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredUnifiedRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={tableColCount} className="h-56 text-center hover:bg-transparent">
                  <UnifiedBudgetEmptyState
                    editable={editable}
                    onCreate={openCreateBucket}
                    filtered={onlyAttention || budgetLineSearch.trim().length > 0}
                  />
                </TableCell>
              </TableRow>
            ) : (
              filteredUnifiedRows.map((row) => {
                const leftToSpend = row.adjustedBudgetCents - row.actualCents
                const inlineEditable = editable && row.lines.length === 1 && row.coAdjustmentCents === 0
                return (
                  <TableRow
                    key={row.key}
                    className="group h-[60px] cursor-pointer hover:bg-muted/30"
                    onClick={() => setActiveBucketKey(row.key)}
                  >
                    {costCodesEnabled && (
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
                    )}
                    <TableCell className="min-w-0 px-4">
                      <div className="flex items-center gap-2">
                        {!costCodesEnabled &&
                          (row.status === "over" ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-label="Over budget" />
                          ) : row.status === "warning" ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" aria-label="Near budget" />
                          ) : (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30" />
                          ))}
                        <span className="block truncate text-sm font-medium">{row.name}</span>
                      </div>
                      {row.lines.length > 0 && (costCodesEnabled || row.lines.length > 1) && (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.lines.length === 1
                            ? row.lines[0].description
                            : `${row.lines.length} budget lines`}
                        </span>
                      )}
                    </TableCell>
                    {isDetailed && (
                      <>
                        <TableCell className="hidden px-4 text-right tabular-nums text-muted-foreground xl:table-cell">
                          <span className="text-sm">{formatCurrency(row.baselineCents ?? row.budgetCents)}</span>
                        </TableCell>
                        <TableCell className="hidden px-4 text-right tabular-nums text-muted-foreground xl:table-cell">
                          <span className="text-sm">{formatCurrency(row.coAdjustmentCents)}</span>
                        </TableCell>
                      </>
                    )}
                    <TableCell className="px-4 text-right tabular-nums">
                      <InlineBudgetAmount
                        cents={row.adjustedBudgetCents}
                        editable={inlineEditable}
                        onCommit={(amount) => updateLineAmount(row.lines[0].id, amount)}
                      />
                    </TableCell>
                    <TableCell className="px-4 text-right tabular-nums text-muted-foreground">
                      <span className="text-sm">{formatCurrency(row.committedCents)}</span>
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
                                  ? "text-amber-600 dark:text-amber-400"
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
            {filteredUnifiedRows.length > 0 && (
              <TableRow className="border-t-2 bg-muted/20 font-medium hover:bg-muted/20">
                <TableCell
                  colSpan={(costCodesEnabled ? 1 : 0) + 1}
                  className="px-4 text-xs uppercase tracking-wide text-muted-foreground"
                >
                  Total · {filteredUnifiedRows.length} {filteredUnifiedRows.length === 1 ? "line" : "lines"}
                </TableCell>
                {isDetailed && (
                  <>
                    <TableCell className="hidden px-4 text-right text-sm tabular-nums xl:table-cell">
                      {formatCurrency(columnTotals.baselineCents)}
                    </TableCell>
                    <TableCell className="hidden px-4 text-right text-sm tabular-nums xl:table-cell">
                      {formatCurrency(columnTotals.coAdjustmentCents)}
                    </TableCell>
                  </>
                )}
                <TableCell className="px-4 text-right text-sm tabular-nums">
                  {formatCurrency(columnTotals.adjustedBudgetCents)}
                </TableCell>
                <TableCell className="px-4 text-right text-sm tabular-nums">
                  {formatCurrency(columnTotals.committedCents)}
                </TableCell>
                <TableCell className="px-4 text-right text-sm tabular-nums">
                  {formatCurrency(columnTotals.actualCents)}
                </TableCell>
                {isDetailed ? (
                  <>
                    <TableCell className="px-4 text-right text-sm tabular-nums">
                      {formatCurrency(columnTotals.costToCompleteCents)}
                    </TableCell>
                    <TableCell className="px-4 text-right text-sm tabular-nums">
                      {formatCurrency(columnTotals.eacCents)}
                    </TableCell>
                    <TableCell className="px-4 text-right text-sm tabular-nums">
                      <span className={cn(columnTotals.varianceAtCompletionCents < 0 ? "text-destructive" : "")}>
                        {formatCurrency(columnTotals.varianceAtCompletionCents)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4" />
                  </>
                ) : (
                  <>
                    <TableCell className="px-4 text-right text-sm tabular-nums">
                      <span className={cn(columnTotals.leftToSpendCents < 0 ? "text-destructive" : "")}>
                        {formatCurrency(columnTotals.leftToSpendCents)}
                      </span>
                    </TableCell>
                    <TableCell className="px-4 text-right text-sm tabular-nums text-muted-foreground">
                      {columnTotals.adjustedBudgetCents > 0
                        ? `${Math.round((columnTotals.actualCents / columnTotals.adjustedBudgetCents) * 100)}%`
                        : "—"}
                    </TableCell>
                  </>
                )}
                <TableCell className="px-2" />
              </TableRow>
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
        costCodesEnabled={costCodesEnabled}
        onEditBucket={() => activeBucket && openEditBucket(activeBucket)}
        onCreateCommitment={() => openCreateCommitment(activeBucket)}
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
      <CsvImportDialog
        open={csvImportOpen}
        onOpenChange={setCsvImportOpen}
        projectId={projectId}
        hasExistingBudget={lines.length > 0}
        costCodesEnabled={costCodesEnabled}
        costCodes={costCodeOptions}
      />
      <CashFlowDialog
        open={cashFlowOpen}
        onOpenChange={setCashFlowOpen}
        startDate={project?.start_date ?? null}
        endDate={project?.end_date ?? null}
        remainingCostCents={summary?.total_ctc_cents ?? 0}
        contractValueCents={contractValue}
        contractBilledCents={contractBilled}
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
  filtered = false,
}: {
  editable: boolean
  onCreate: () => void
  filtered?: boolean
}) {
  // When the empty state is the result of a search/filter, keep it minimal.
  if (filtered) {
    return (
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <ListOrdered className="h-6 w-6" />
        </div>
        <p className="font-medium">No matching budget lines</p>
        <p className="text-sm text-muted-foreground">Try clearing the search or the “need attention” filter.</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-4 py-2">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <ListOrdered className="h-6 w-6" />
      </div>
      <div className="max-w-[460px] text-center">
        <p className="font-medium">Build your project budget</p>
        <p className="mt-0.5 text-sm text-muted-foreground">
          Start a line for each part of the job — framing, plumbing, allowances — with the amount you
          expect to spend. Then buy it out with subcontracts &amp; POs and track spend as bills come in.
        </p>
      </div>
      {/* Three-step primer mirrors the workflow helper above the table. */}
      <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="rounded-full bg-muted px-2.5 py-1">1 · Set budget</span>
        <span className="rounded-full bg-muted px-2.5 py-1">2 · Buy it out</span>
        <span className="rounded-full bg-muted px-2.5 py-1">3 · Track spend</span>
      </div>
      {editable && (
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" onClick={onCreate}>
              <Plus className="h-4 w-4" />
              Add line
            </Button>
            <Button size="sm" variant="outline" disabled>
              <Sparkles className="h-4 w-4" />
              Start from estimate
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">“Start from estimate” — coming soon</span>
        </div>
      )}
    </div>
  )
}

type EstimateSourceOption = {
  id: string
  label: string
  status: string
  total_cents: number
  line_count: number
}

type ReviewLine = {
  cost_code_id: string | null
  cost_code_label: string | null
  description: string
  amountDollars: string
  include: boolean
}

/**
 * "Start from estimate" — picks a project estimate, proposes budget lines from
 * its cost basis (AI tidies the scope notes), and lets the user review/edit
 * before saving. AI proposes; the human approves.
 */
function EstimateImportDialog({
  open,
  onOpenChange,
  projectId,
  hasExistingBudget,
  costCodesEnabled,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  hasExistingBudget: boolean
  costCodesEnabled: boolean
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isApplying, startApply] = useTransition()

  const [loadingSources, setLoadingSources] = useState(false)
  const [sources, setSources] = useState<EstimateSourceOption[]>([])
  const [selectedId, setSelectedId] = useState<string>("")
  const [generating, setGenerating] = useState(false)
  const [usedAi, setUsedAi] = useState(false)
  const [reviewLines, setReviewLines] = useState<ReviewLine[] | null>(null)

  // Load the project's estimates whenever the dialog opens.
  useEffect(() => {
    if (!open) {
      setSources([])
      setSelectedId("")
      setReviewLines(null)
      setUsedAi(false)
      return
    }
    let cancelled = false
    setLoadingSources(true)
    listBudgetEstimateSourcesAction(projectId)
      .then((rows) => {
        if (cancelled) return
        setSources(rows)
        if (rows.length === 1) setSelectedId(rows[0].id)
      })
      .catch((error) => {
        if (!cancelled) toast({ title: "Couldn't load estimates", description: (error as Error).message })
      })
      .finally(() => {
        if (!cancelled) setLoadingSources(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, projectId, toast])

  const generate = (estimateId: string) => {
    if (!estimateId) return
    setGenerating(true)
    setReviewLines(null)
    proposeBudgetFromEstimateAction(projectId, estimateId, costCodesEnabled)
      .then((draft) => {
        setUsedAi(draft.used_ai)
        setReviewLines(
          draft.lines.map((line) => ({
            cost_code_id: line.cost_code_id,
            cost_code_label: line.cost_code_label,
            description: line.description,
            amountDollars: (line.amount_cents / 100).toFixed(2),
            include: true,
          })),
        )
      })
      .catch((error) => {
        toast({ title: "Couldn't build the budget", description: (error as Error).message })
      })
      .finally(() => setGenerating(false))
  }

  const includedLines = (reviewLines ?? []).filter((line) => line.include)
  const totalCents = includedLines.reduce(
    (sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0),
    0,
  )

  const apply = () => {
    const payloadLines = includedLines
      .map((line) => ({
        cost_code_id: costCodesEnabled ? line.cost_code_id : null,
        description: line.description.trim() || "Budget line",
        amount_cents: dollarsToCents(line.amountDollars) ?? 0,
      }))
      .filter((line) => line.amount_cents >= 0)

    if (payloadLines.length === 0) {
      toast({ title: "Select at least one line" })
      return
    }

    startApply(async () => {
      try {
        await applyBudgetFromEstimateAction({ project_id: projectId, lines: payloadLines })
        toast({ title: "Budget created from estimate" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Couldn't save the budget", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Start budget from estimate</DialogTitle>
          <DialogDescription>
            We&apos;ll turn an accepted estimate into budget lines using its cost basis (excluding
            markup). Review and adjust before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto">
          {loadingSources ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading estimates…</p>
          ) : sources.length === 0 ? (
            <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              No estimates with cost lines were found for this project.
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="flex-1 space-y-1.5">
                  <Label>Estimate</Label>
                  <Select value={selectedId} onValueChange={setSelectedId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select an estimate" />
                    </SelectTrigger>
                    <SelectContent>
                      {sources.map((source) => (
                        <SelectItem key={source.id} value={source.id}>
                          {source.label} · {source.line_count} {source.line_count === 1 ? "line" : "lines"} ·{" "}
                          {formatCurrency(source.total_cents, { compact: true })}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button onClick={() => generate(selectedId)} disabled={!selectedId || generating}>
                  <Sparkles className="h-4 w-4" />
                  {generating ? "Building…" : reviewLines ? "Rebuild" : "Build budget"}
                </Button>
              </div>

              {hasExistingBudget && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  This project already has a budget. Saving will replace its current lines.
                </div>
              )}

              {reviewLines && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {includedLines.length} of {reviewLines.length} lines selected
                      {usedAi ? " · scope notes tidied by AI" : ""}
                    </p>
                    <p className="text-sm font-semibold tabular-nums">{formatCurrency(totalCents)}</p>
                  </div>
                  <div className="overflow-hidden rounded-lg border">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/40">
                          <TableHead className="w-10 px-3" />
                          {costCodesEnabled && <TableHead className="px-3">Code</TableHead>}
                          <TableHead className="px-3">Scope</TableHead>
                          <TableHead className="w-[130px] px-3 text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {reviewLines.map((line, index) => (
                          <TableRow key={index} className={cn(!line.include && "opacity-50")}>
                            <TableCell className="px-3">
                              <input
                                type="checkbox"
                                checked={line.include}
                                onChange={(event) =>
                                  setReviewLines((prev) =>
                                    (prev ?? []).map((item, i) =>
                                      i === index ? { ...item, include: event.target.checked } : item,
                                    ),
                                  )
                                }
                                className="h-4 w-4 rounded border-input"
                              />
                            </TableCell>
                            {costCodesEnabled && (
                              <TableCell className="px-3 font-mono text-xs text-muted-foreground">
                                {line.cost_code_label ?? "Uncoded"}
                              </TableCell>
                            )}
                            <TableCell className="px-3">
                              <Input
                                value={line.description}
                                onChange={(event) =>
                                  setReviewLines((prev) =>
                                    (prev ?? []).map((item, i) =>
                                      i === index ? { ...item, description: event.target.value } : item,
                                    ),
                                  )
                                }
                                className="h-8"
                              />
                            </TableCell>
                            <TableCell className="px-3 text-right">
                              <Input
                                value={line.amountDollars}
                                inputMode="decimal"
                                onChange={(event) =>
                                  setReviewLines((prev) =>
                                    (prev ?? []).map((item, i) =>
                                      i === index ? { ...item, amountDollars: event.target.value } : item,
                                    ),
                                  )
                                }
                                className="h-8 text-right tabular-nums"
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!reviewLines || includedLines.length === 0 || isApplying}>
            {isApplying ? "Saving…" : `Create budget (${includedLines.length})`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Parses a CSV string into rows of fields (handles quoted fields and commas). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ""
  let row: string[] = []
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
    } else if (char === '"') {
      inQuotes = true
    } else if (char === ",") {
      row.push(field)
      field = ""
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0))
}

/** Imports budget lines from a CSV with code/description/amount columns. */
function CsvImportDialog({
  open,
  onOpenChange,
  projectId,
  hasExistingBudget,
  costCodesEnabled,
  costCodes,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  hasExistingBudget: boolean
  costCodesEnabled: boolean
  costCodes: CostCode[]
}) {
  const { toast } = useToast()
  const router = useRouter()
  const [isApplying, startApply] = useTransition()
  const [reviewLines, setReviewLines] = useState<ReviewLine[] | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setReviewLines(null)
      setParseError(null)
    }
  }, [open])

  const codeIdByCode = useMemo(() => {
    const map = new Map<string, { id: string; label: string }>()
    for (const code of costCodes) {
      if (code.code) {
        const label = [code.code, code.name].filter(Boolean).join(" — ")
        map.set(code.code.trim().toLowerCase(), { id: code.id, label })
      }
    }
    return map
  }, [costCodes])

  const handleFile = async (file: File) => {
    setParseError(null)
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length === 0) {
        setParseError("That file looks empty.")
        return
      }
      // Locate columns from the header row.
      const header = rows[0].map((cell) => cell.trim().toLowerCase())
      const findCol = (names: string[]) => header.findIndex((cell) => names.includes(cell))
      const codeCol = findCol(["code", "cost code", "cost_code"])
      const descCol = findCol(["description", "scope", "name", "budget line", "line"])
      const amountCol = findCol(["amount", "budget", "total", "cost", "revised"])
      if (descCol === -1 || amountCol === -1) {
        setParseError("Couldn't find a description and amount column. Use headers like: code, description, amount.")
        return
      }
      const parsed: ReviewLine[] = rows.slice(1).flatMap((cells) => {
        const description = (cells[descCol] ?? "").trim()
        const rawAmount = (cells[amountCol] ?? "").replace(/[$,]/g, "").trim()
        if (!description && !rawAmount) return []
        const codeText = codeCol >= 0 ? (cells[codeCol] ?? "").trim() : ""
        const matched = codeText ? codeIdByCode.get(codeText.toLowerCase()) : undefined
        const cents = dollarsToCents(rawAmount)
        return [
          {
            cost_code_id: costCodesEnabled ? matched?.id ?? null : null,
            cost_code_label: costCodesEnabled ? matched?.label ?? (codeText || null) : null,
            description: description || "Budget line",
            amountDollars: cents != null ? (cents / 100).toFixed(2) : "0.00",
            include: true,
          },
        ]
      })
      if (parsed.length === 0) {
        setParseError("No data rows found under the header.")
        return
      }
      setReviewLines(parsed)
    } catch (error) {
      setParseError((error as Error).message)
    }
  }

  const includedLines = (reviewLines ?? []).filter((line) => line.include)
  const totalCents = includedLines.reduce(
    (sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0),
    0,
  )

  const apply = () => {
    const payloadLines = includedLines.map((line) => ({
      cost_code_id: costCodesEnabled ? line.cost_code_id : null,
      description: line.description.trim() || "Budget line",
      amount_cents: dollarsToCents(line.amountDollars) ?? 0,
    }))
    if (payloadLines.length === 0) {
      toast({ title: "Select at least one line" })
      return
    }
    startApply(async () => {
      try {
        await applyBudgetFromEstimateAction({ project_id: projectId, lines: payloadLines })
        toast({ title: "Budget imported" })
        onOpenChange(false)
        router.refresh()
      } catch (error) {
        toast({ title: "Couldn't import the budget", description: (error as Error).message })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Import budget from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with <span className="font-medium">description</span> and{" "}
            <span className="font-medium">amount</span> columns (and an optional{" "}
            <span className="font-medium">code</span> column). Review before saving.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto">
          <div className="flex items-center gap-3">
            <Input
              type="file"
              accept=".csv,text/csv"
              className="cursor-pointer"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
          </div>

          {parseError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {parseError}
            </div>
          )}

          {hasExistingBudget && reviewLines && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              This project already has a budget. Saving will replace its current lines.
            </div>
          )}

          {reviewLines && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {includedLines.length} of {reviewLines.length} lines selected
                </p>
                <p className="text-sm font-semibold tabular-nums">{formatCurrency(totalCents)}</p>
              </div>
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="w-10 px-3" />
                      {costCodesEnabled && <TableHead className="px-3">Code</TableHead>}
                      <TableHead className="px-3">Description</TableHead>
                      <TableHead className="w-[130px] px-3 text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reviewLines.map((line, index) => (
                      <TableRow key={index} className={cn(!line.include && "opacity-50")}>
                        <TableCell className="px-3">
                          <input
                            type="checkbox"
                            checked={line.include}
                            onChange={(event) =>
                              setReviewLines((prev) =>
                                (prev ?? []).map((item, i) =>
                                  i === index ? { ...item, include: event.target.checked } : item,
                                ),
                              )
                            }
                            className="h-4 w-4 rounded border-input"
                          />
                        </TableCell>
                        {costCodesEnabled && (
                          <TableCell className="px-3 font-mono text-xs text-muted-foreground">
                            {line.cost_code_label ?? "Uncoded"}
                          </TableCell>
                        )}
                        <TableCell className="px-3">
                          <Input
                            value={line.description}
                            onChange={(event) =>
                              setReviewLines((prev) =>
                                (prev ?? []).map((item, i) =>
                                  i === index ? { ...item, description: event.target.value } : item,
                                ),
                              )
                            }
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell className="px-3 text-right">
                          <Input
                            value={line.amountDollars}
                            inputMode="decimal"
                            onChange={(event) =>
                              setReviewLines((prev) =>
                                (prev ?? []).map((item, i) =>
                                  i === index ? { ...item, amountDollars: event.target.value } : item,
                                ),
                              )
                            }
                            className="h-8 text-right tabular-nums"
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={apply} disabled={!reviewLines || includedLines.length === 0 || isApplying}>
            {isApplying ? "Saving…" : `Import ${includedLines.length} lines`}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type CashFlowRow = {
  label: string
  spendCents: number
  billingCents: number
  netCents: number
  cumulativeCents: number
}

/**
 * Straight-line cash-flow forecast. Spreads remaining cost (cost-to-complete)
 * and remaining billing evenly across the months left in the project schedule,
 * then shows net and cumulative cash position so crunch months stand out. This
 * is a projection, not a committed draw schedule.
 */
function CashFlowDialog({
  open,
  onOpenChange,
  startDate,
  endDate,
  remainingCostCents,
  contractValueCents,
  contractBilledCents,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  startDate: string | null
  endDate: string | null
  remainingCostCents: number
  contractValueCents: number
  contractBilledCents: number
}) {
  const forecast = useMemo(() => {
    if (!endDate) return null
    const end = new Date(endDate)
    if (Number.isNaN(end.getTime())) return null

    const now = new Date()
    const start = startDate ? new Date(startDate) : now
    const firstMonth = new Date(Math.max(now.getTime(), Number.isNaN(start.getTime()) ? now.getTime() : start.getTime()))
    firstMonth.setDate(1)
    firstMonth.setHours(0, 0, 0, 0)
    const lastMonth = new Date(end.getFullYear(), end.getMonth(), 1)
    if (lastMonth < firstMonth) return null

    const months: Date[] = []
    const cursor = new Date(firstMonth)
    while (cursor <= lastMonth && months.length < 60) {
      months.push(new Date(cursor))
      cursor.setMonth(cursor.getMonth() + 1)
    }
    const n = months.length
    if (n === 0) return null

    const remainingBilling = Math.max(0, contractValueCents - contractBilledCents)
    const spendPer = Math.round(remainingCostCents / n)
    const billPer = Math.round(remainingBilling / n)

    let cumulative = 0
    const rows: CashFlowRow[] = months.map((month, index) => {
      const isLast = index === n - 1
      const spend = isLast ? remainingCostCents - spendPer * (n - 1) : spendPer
      const billing = isLast ? remainingBilling - billPer * (n - 1) : billPer
      const net = billing - spend
      cumulative += net
      return {
        label: month.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        spendCents: spend,
        billingCents: billing,
        netCents: net,
        cumulativeCents: cumulative,
      }
    })

    const peakSpend = Math.max(1, ...rows.map((row) => row.spendCents))
    const lowestCumulative = Math.min(...rows.map((row) => row.cumulativeCents))
    return { rows, peakSpend, remainingBilling, lowestCumulative }
  }, [startDate, endDate, remainingCostCents, contractValueCents, contractBilledCents])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Cash flow forecast</DialogTitle>
          <DialogDescription>
            Remaining cost and billing spread evenly across the months left in the schedule. A
            projection to spot crunch months — not a committed draw schedule.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto">
          {!forecast ? (
            <div className="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground">
              Add project start and end dates to forecast cash flow.
            </div>
          ) : (
            <div className="space-y-3">
              {forecast.lowestCumulative < 0 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Projected cash dips to {formatCurrency(forecast.lowestCumulative)} — you may need to
                  bill earlier or carry the gap.
                </div>
              )}
              <div className="overflow-hidden rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/40">
                      <TableHead className="px-4">Month</TableHead>
                      <TableHead className="px-4">Spend</TableHead>
                      <TableHead className="w-[110px] px-4 text-right">Billing</TableHead>
                      <TableHead className="w-[110px] px-4 text-right">Net</TableHead>
                      <TableHead className="w-[120px] px-4 text-right">Cumulative</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {forecast.rows.map((row) => (
                      <TableRow key={row.label}>
                        <TableCell className="px-4 text-sm font-medium">{row.label}</TableCell>
                        <TableCell className="px-4">
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-full max-w-[120px] overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-foreground/60"
                                style={{ width: `${Math.round((row.spendCents / forecast.peakSpend) * 100)}%` }}
                              />
                            </div>
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {formatCurrency(row.spendCents, { compact: true })}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="px-4 text-right text-sm tabular-nums text-muted-foreground">
                          {formatCurrency(row.billingCents, { compact: true })}
                        </TableCell>
                        <TableCell className="px-4 text-right text-sm tabular-nums">
                          <span className={cn(row.netCents < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
                            {formatCurrency(row.netCents, { compact: true })}
                          </span>
                        </TableCell>
                        <TableCell className="px-4 text-right text-sm font-medium tabular-nums">
                          <span className={cn(row.cumulativeCents < 0 ? "text-destructive" : "")}>
                            {formatCurrency(row.cumulativeCents, { compact: true })}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="text-xs text-muted-foreground">
                Based on {formatCurrency(remainingCostCents)} remaining cost and{" "}
                {formatCurrency(forecast.remainingBilling)} left to bill over {forecast.rows.length}{" "}
                {forecast.rows.length === 1 ? "month" : "months"}.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t pt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function BudgetBucketSheet({
  projectId,
  bucket,
  open,
  onOpenChange,
  commitments,
  commitmentsLoading,
  costCodesEnabled,
  onEditBucket,
  onCreateCommitment,
  onEditCommitment,
  onCommitmentLines,
  onCommitmentFiles,
  onCommitmentSignature,
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
    coAdjustmentCents: number
    adjustedBudgetCents: number
    baselineCents?: number | null
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
  costCodesEnabled: boolean
  onEditBucket: () => void
  onCreateCommitment: () => void
  onEditCommitment: (commitment: CommitmentSummary) => void
  onCommitmentLines: (commitment: CommitmentSummary) => void
  onCommitmentFiles: (commitment: CommitmentSummary) => void
  onCommitmentSignature: (commitment: CommitmentSummary) => void
}) {
  const [changeOrders, setChangeOrders] = useState<
    Array<{ id: string; title: string; status: string; approved_at: string | null; amount_cents: number }>
  >([])
  const [changeOrdersLoading, setChangeOrdersLoading] = useState(false)

  const bucketCoKey = costCodesEnabled ? bucket?.costCodeId ?? null : bucket?.key ?? null
  const hasCoAdjustment = (bucket?.coAdjustmentCents ?? 0) !== 0

  // Load the change orders that adjusted this bucket when the sheet opens.
  useEffect(() => {
    if (!open || !bucket || !hasCoAdjustment || !bucketCoKey) {
      setChangeOrders([])
      return
    }
    let cancelled = false
    setChangeOrdersLoading(true)
    fetchBudgetBucketChangeOrdersAction(
      projectId,
      bucketCoKey,
      costCodesEnabled ? "cost_code" : "budget_line",
    )
      .then((rows) => {
        if (!cancelled) setChangeOrders(rows)
      })
      .catch(() => {
        if (!cancelled) setChangeOrders([])
      })
      .finally(() => {
        if (!cancelled) setChangeOrdersLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, bucket, bucketCoKey, costCodesEnabled, hasCoAdjustment, projectId])

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
                {bucket && bucket.baselineCents != null && bucket.baselineCents !== bucket.budgetCents && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Original {formatCurrency(bucket.baselineCents)} ·{" "}
                    <span className={cn(bucket.budgetCents - bucket.baselineCents > 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400")}>
                      {bucket.budgetCents - bucket.baselineCents > 0 ? "+" : ""}
                      {formatCurrency(bucket.budgetCents - bucket.baselineCents)} since baseline
                    </span>
                  </p>
                )}
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

            {hasCoAdjustment && (
              <div className="space-y-3">
                <div>
                  <h4 className="text-sm font-semibold">Change orders</h4>
                  <p className="text-xs text-muted-foreground">
                    Approved change orders that moved this line&apos;s budget.
                  </p>
                </div>
                {changeOrdersLoading ? (
                  <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                    Loading change orders…
                  </div>
                ) : changeOrders.length > 0 ? (
                  <div className="overflow-hidden rounded-lg border">
                    {changeOrders.map((co) => (
                      <Link
                        key={co.id}
                        href={`/projects/${projectId}/change-orders?co=${co.id}`}
                        className="flex items-center justify-between gap-3 border-b px-4 py-2.5 text-sm last:border-b-0 hover:bg-muted/40"
                      >
                        <div className="min-w-0">
                          <span className="block truncate font-medium">{co.title}</span>
                          {co.approved_at && (
                            <span className="block text-xs text-muted-foreground">
                              Approved {new Date(co.approved_at).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                        <span
                          className={cn(
                            "shrink-0 tabular-nums",
                            co.amount_cents < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400",
                          )}
                        >
                          {co.amount_cents > 0 ? "+" : ""}
                          {formatCurrency(co.amount_cents)}
                        </span>
                      </Link>
                    ))}
                    <div className="flex items-center justify-between bg-muted/30 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      <span>Total adjustment</span>
                      <span className="tabular-nums">{formatCurrency(bucket?.coAdjustmentCents ?? 0)}</span>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-dashed px-4 py-3 text-xs text-muted-foreground">
                    This line&apos;s budget was adjusted by {formatCurrency(bucket?.coAdjustmentCents ?? 0)} via change
                    orders or posted revisions.
                  </div>
                )}
              </div>
            )}

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
                                  <DropdownMenuItem onClick={() => onCommitmentSignature(c)}>
                                    Send for signature
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
              {costCodesEnabled
                ? draft?.key
                  ? "Edit cost bucket"
                  : "Add cost bucket"
                : draft?.key
                  ? "Edit budget line"
                  : "Add budget line"}
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
                  {costCodesEnabled ? "Remove bucket" : "Remove line"}
                </Button>
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={submit} disabled={!canSave}>
                {draft?.key ? (costCodesEnabled ? "Save bucket" : "Save line") : costCodesEnabled ? "Add bucket" : "Add line"}
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
  const [contractNumber, setContractNumber] = useState("")
  const [retainagePercent, setRetainagePercent] = useState("")
  const [terms, setTerms] = useState("")

  useEffect(() => {
    if (open) {
      setCompanyId(companies[0]?.id ?? "")
      setCostCodeId(costCodesEnabled ? draft?.costCodeId ?? costCodes[0]?.id ?? "" : "")
      setTitle("")
      setScope(draft?.defaultScope ?? "")
      setAmountDollars(draft?.defaultAmountDollars ?? "")
      setStatus("draft")
      setContractNumber("")
      setRetainagePercent("")
      setTerms("")
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
    const retainage = retainagePercent.trim() ? Number(retainagePercent) : null
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage" })
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
          contract_number: contractNumber.trim() || null,
          retainage_percent: retainage,
          scope: scope.trim(),
          terms: terms.trim() || null,
        })
        await createCommitmentLineAction(commitment.id, {
          cost_code_id: costCodesEnabled ? costCodeId : null,
          budget_line_id: costCodesEnabled ? null : draft?.budgetLineId ?? null,
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
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Commitment #</Label>
              <Input
                value={contractNumber}
                onChange={(e) => setContractNumber(e.target.value)}
                placeholder="e.g., SUB-004"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Retainage (%)</Label>
              <Input
                value={retainagePercent}
                onChange={(e) => setRetainagePercent(e.target.value)}
                inputMode="decimal"
                placeholder="10"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Allocated scope</Label>
            <Textarea
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              placeholder="e.g., Rough plumbing labor and trim"
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Terms</Label>
            <Textarea
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="Billing terms, insurance, lien waivers, schedule"
              rows={3}
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
  const [contractNumber, setContractNumber] = useState("")
  const [retainagePercent, setRetainagePercent] = useState("")
  const [scope, setScope] = useState("")
  const [terms, setTerms] = useState("")

  useEffect(() => {
    if (commitment) {
      setTitle(commitment.title ?? "")
      setTotalDollars(((commitment.total_cents ?? 0) / 100).toFixed(2))
      setStatus(String(commitment.status ?? "draft"))
      setContractNumber(commitment.contract_number ?? "")
      setRetainagePercent(commitment.retainage_percent != null ? String(commitment.retainage_percent) : "")
      setScope(commitment.scope ?? "")
      setTerms(commitment.terms ?? "")
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
    const retainage = retainagePercent.trim() ? Number(retainagePercent) : null
    if (retainage != null && (!Number.isFinite(retainage) || retainage < 0 || retainage > 100)) {
      toast({ title: "Invalid retainage" })
      return
    }

    startTransition(async () => {
      try {
        await updateProjectCommitmentAction(projectId, commitment.id, {
          title: title.trim(),
          status,
          total_cents: Math.round(n * 100),
          contract_number: contractNumber.trim() || null,
          retainage_percent: retainage,
          scope: scope.trim() || null,
          terms: terms.trim() || null,
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
          <DialogDescription>Update amount, status, scope, and commercial terms.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Commitment #</Label>
              <Input value={contractNumber} onChange={(e) => setContractNumber(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Retainage (%)</Label>
              <Input
                value={retainagePercent}
                onChange={(e) => setRetainagePercent(e.target.value)}
                inputMode="decimal"
              />
            </div>
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
          <div className="space-y-1.5">
            <Label>Scope</Label>
            <Textarea value={scope} onChange={(e) => setScope(e.target.value)} rows={3} />
          </div>
          <div className="space-y-1.5">
            <Label>Terms</Label>
            <Textarea value={terms} onChange={(e) => setTerms(e.target.value)} rows={3} />
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
  defaultBudgetLineId,
}: {
  commitment: CommitmentSummary | null
  onClose: () => void
  costCodesEnabled: boolean
  defaultBudgetLineId?: string | null
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
          defaultBudgetLineId={defaultBudgetLineId}
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
  defaultBudgetLineId,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commitmentId: string
  line: CommitmentLine | null
  costCodes: CostCode[]
  costCodesEnabled: boolean
  defaultBudgetLineId?: string | null
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
          budget_line_id: costCodesEnabled ? null : line?.budget_line_id ?? defaultBudgetLineId ?? null,
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
