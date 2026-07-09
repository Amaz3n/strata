"use client"

import Link from "next/link"
import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FileText,
  MoreHorizontal,
  Plus,
  ReceiptText,
  Timer,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import {
  approveInboxExpenseAction,
  approveInboxTimeEntryAction,
  approveInboxVendorBillAction,
  rejectInboxExpenseAction,
  rejectInboxTimeEntryAction,
  sendInboxTimeEntryClientApprovalAction,
} from "@/app/(app)/projects/[id]/cost-inbox/actions"
import {
  createManualBillableAdjustmentAction,
  createProjectBillingPeriodAction,
  generateInvoiceFromCostsAction,
} from "@/app/(app)/projects/[id]/financials/actions"
import { cn } from "@/lib/utils"
import type { ProjectFeeBillingSummary } from "@/lib/services/fee-billing"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { ReviewDetailOverlays, type ReviewOverlayTarget } from "./review-detail-overlays"

import { unwrapAction } from "@/lib/action-result"

interface CostCodeOption {
  id: string
  code?: string | null
  name?: string | null
}

interface BillingPeriodOption {
  id: string
  name: string
  period_start: string
  period_end: string
  status: "open" | "reviewing" | "invoiced" | "closed" | "reopened"
}

interface ReviewQueueTableProps {
  projectId: string
  timeEntries: any[]
  expenses: any[]
  vendorBills: VendorBillSummary[]
  openCosts: any[]
  billingPeriods?: BillingPeriodOption[]
  costCodes: CostCodeOption[]
  costCodesEnabled?: boolean
  feeSummary?: ProjectFeeBillingSummary | null
  loadErrors?: string[]
}

type QueueState = "needs-review" | "blocked" | "awaiting-client-approval" | "ready-to-invoice" | "billed"
type QueueKind = "time" | "expense" | "vendor_bill" | "billable_cost"
type TabValue = "all" | "needs-review" | "blocked" | "awaiting-client-approval" | "ready-to-invoice" | "billed"

interface QueueItem {
  id: string
  recordId: string
  kind: QueueKind
  tabState: QueueState
  typeLabel: string
  source: string
  description: string
  amountCents: number
  date?: string | null
  ageDays: number
  initialCostCodeId?: string | null
  initialCostCodeLabel: string
  needsCostCode: boolean
  needsRate?: boolean
  needsReceipt?: boolean
  proofComplete?: boolean
  paidEligible?: boolean
  blockingReasons: string[]
  billingPeriodName?: string | null
  billingPeriodStatus?: string | null
  lateToBillingPeriodName?: string | null
  recentInvoice?: {
    id: string
    invoice_number?: string | null
    status?: string | null
  } | null
  canChooseCostCode: boolean
  sourceRecord: any
}

const NO_COST_CODE = "__none__"
const NO_BILLING_PERIOD = "__none__"
const NEW_BILLING_PERIOD = "__new_period__"
const REVIEW_QUEUE_PAGE_SIZE = 200

export function ReviewQueueTable({
  projectId,
  timeEntries,
  expenses,
  vendorBills,
  openCosts,
  billingPeriods = [],
  costCodes,
  costCodesEnabled = true,
  feeSummary = null,
  loadErrors = [],
}: ReviewQueueTableProps) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [chosenCostCodes, setChosenCostCodes] = useState<Record<string, string>>({})
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => new Set())
  const [overlayTarget, setOverlayTarget] = useState<ReviewOverlayTarget | null>(null)
  const [bulkCostCodeId, setBulkCostCodeId] = useState<string>(NO_COST_CODE)
  const [activeTab, setActiveTab] = useState<TabValue>("needs-review")
  const [pageIndex, setPageIndex] = useState(0)
  const [invoicePreview, setInvoicePreview] = useState<any | null>(null)
  const [invoicePreviewCostIds, setInvoicePreviewCostIds] = useState<string[]>([])
  const [overrideGmpCap, setOverrideGmpCap] = useState(false)
  const [includeEarnedFee, setIncludeEarnedFee] = useState(false)
  const [periodDialogOpen, setPeriodDialogOpen] = useState(false)
  const [periodName, setPeriodName] = useState("")
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [adjustmentDialogOpen, setAdjustmentDialogOpen] = useState(false)
  const [adjustmentAmount, setAdjustmentAmount] = useState("")
  const [adjustmentDate, setAdjustmentDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [adjustmentCostCodeId, setAdjustmentCostCodeId] = useState(NO_COST_CODE)
  const [adjustmentGmpClassification, setAdjustmentGmpClassification] = useState<"inside_gmp" | "outside_gmp">("inside_gmp")
  const [adjustmentDescription, setAdjustmentDescription] = useState("")
  const [adjustmentReason, setAdjustmentReason] = useState("")
  const [billingPeriodId, setBillingPeriodId] = useState<string>(() => {
    const activePeriod = billingPeriods.find((period) => ["open", "reviewing", "reopened"].includes(period.status))
    return activePeriod?.id ?? NO_BILLING_PERIOD
  })
  const [isPending, startTransition] = useTransition()

  const costCodeNames = useMemo(() => new Map(costCodes.map((code) => [code.id, formatCostCode(code)])), [costCodes])

  const items = useMemo(() => {
    const rows: QueueItem[] = []

    for (const entry of timeEntries) {
      const missingRate = Number(entry.base_rate_cents ?? 0) <= 0
      const missingCostCode = costCodesEnabled && !entry.cost_code_id
      rows.push({
        id: `time:${entry.id}`,
        recordId: entry.id,
        kind: "time",
        tabState:
          entry.queue_state ??
          (entry.status === "pm_approved"
            ? "awaiting-client-approval"
            : missingRate || missingCostCode
              ? "blocked"
              : "needs-review"),
        typeLabel: "Time",
        source: entry.worker_name ?? "Crew time",
        description: entry.notes || `${Number(entry.hours ?? 0).toFixed(2)} hours`,
        amountCents: Number(entry.cost_cents ?? 0),
        date: entry.work_date,
        ageDays: ageDays(entry.work_date),
        initialCostCodeId: entry.cost_code_id ?? null,
        initialCostCodeLabel: entry.cost_code_id
          ? (costCodeNames.get(entry.cost_code_id) ?? "Cost code")
          : "Choose One",
        needsCostCode: missingCostCode,
        needsRate: missingRate,
        needsReceipt: entry.proof_complete === false,
        proofComplete: entry.proof_complete,
        paidEligible: entry.paid_eligible,
        blockingReasons: entry.blocking_reasons ?? [],
        billingPeriodName: entry.billing_period_name ?? null,
        billingPeriodStatus: entry.billing_period_status ?? null,
        lateToBillingPeriodName: entry.late_to_billing_period_name ?? null,
        recentInvoice: null,
        canChooseCostCode: costCodesEnabled,
        sourceRecord: entry,
      })
    }

    for (const expense of expenses) {
      const missingCostCode = costCodesEnabled && !expense.cost_code_id
      const missingReceipt = !expense.receipt_file_id
      rows.push({
        id: `expense:${expense.id}`,
        recordId: expense.id,
        kind: "expense",
        tabState:
          expense.queue_state ??
          (expense.status === "draft" || missingCostCode || missingReceipt ? "blocked" : "needs-review"),
        typeLabel: "Expense",
        source: expense.vendor_company?.name ?? expense.vendor_name_text ?? "Expense",
        description: expense.description ?? "Project expense",
        amountCents: Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
        date: expense.expense_date,
        ageDays: ageDays(expense.expense_date),
        initialCostCodeId: expense.cost_code_id ?? null,
        initialCostCodeLabel: expense.cost_code?.code
          ? `${expense.cost_code.code} ${expense.cost_code.name ?? ""}`.trim()
          : "Choose One",
        needsCostCode: missingCostCode,
        needsRate: false,
        needsReceipt: expense.proof_complete === false || missingReceipt,
        proofComplete: expense.proof_complete,
        paidEligible: expense.paid_eligible,
        blockingReasons: expense.blocking_reasons ?? [],
        billingPeriodName: expense.billing_period_name ?? null,
        billingPeriodStatus: expense.billing_period_status ?? null,
        lateToBillingPeriodName: expense.late_to_billing_period_name ?? null,
        recentInvoice: null,
        canChooseCostCode: costCodesEnabled,
        sourceRecord: expense,
      })
    }

    for (const bill of vendorBills) {
      const actualLines = bill.actual_lines ?? []
      const firstLine = actualLines[0]
      const hasMultipleLines = actualLines.length > 1
      const isCoded =
        !costCodesEnabled || (actualLines.length > 0 && actualLines.every((line) => Boolean(line.cost_code_id)))
      rows.push({
        id: `vendor_bill:${bill.id}`,
        recordId: bill.id,
        kind: "vendor_bill",
        tabState: (bill as any).queue_state ?? (isCoded ? "needs-review" : "blocked"),
        typeLabel: "Vendor Bill",
        source: bill.company_name ?? "Vendor",
        description: bill.bill_number ?? bill.commitment_title ?? "Vendor bill",
        amountCents: Number(bill.total_cents ?? 0),
        date: bill.due_date ?? bill.bill_date,
        ageDays: ageDays(bill.bill_date ?? bill.due_date),
        initialCostCodeId: firstLine?.cost_code_id ?? null,
        initialCostCodeLabel: isCoded ? summarizeBillCostCodes(bill) : "Choose One",
        needsCostCode: !isCoded,
        needsRate: false,
        needsReceipt: (bill as any).proof_complete === false,
        proofComplete: (bill as any).proof_complete,
        paidEligible: (bill as any).paid_eligible,
        blockingReasons: (bill as any).blocking_reasons ?? [],
        billingPeriodName: (bill as any).billing_period_name ?? null,
        billingPeriodStatus: (bill as any).billing_period_status ?? null,
        lateToBillingPeriodName: (bill as any).late_to_billing_period_name ?? null,
        recentInvoice: null,
        canChooseCostCode: costCodesEnabled && !hasMultipleLines,
        sourceRecord: bill,
      })
    }

    for (const cost of openCosts) {
      rows.push({
        id: `billable_cost:${cost.id}`,
        recordId: cost.id,
        kind: "billable_cost",
        tabState: cost.queue_state ?? (cost.status === "billed" ? "billed" : "ready-to-invoice"),
        typeLabel: "Billable Cost",
        source: formatSourceType(cost.source_type),
        description: cost.description ?? "Billable cost",
        amountCents: Number(cost.billable_cents ?? 0),
        date: cost.occurred_on,
        ageDays: ageDays(cost.occurred_on),
        initialCostCodeId: cost.cost_code_id ?? null,
        initialCostCodeLabel: cost.cost_code_code
          ? `${cost.cost_code_code} ${cost.cost_code_name ?? ""}`.trim()
          : "Choose One",
        needsCostCode: false,
        needsRate: false,
        needsReceipt: cost.proof_complete === false,
        proofComplete: cost.proof_complete,
        paidEligible: cost.paid_eligible,
        blockingReasons: cost.blocking_reasons ?? [],
        billingPeriodName: cost.billing_period_name ?? null,
        billingPeriodStatus: cost.billing_period_status ?? null,
        lateToBillingPeriodName: cost.late_to_billing_period_name ?? null,
        recentInvoice: cost.recent_invoice ?? null,
        canChooseCostCode: false,
        sourceRecord: cost,
      })
    }

    return rows
      .map((row) => (completedIds.has(row.id) ? { ...row, tabState: "billed" as const } : row))
      .sort((a, b) => {
        const stateOrder = stateRank(a.tabState) - stateRank(b.tabState)
        if (stateOrder !== 0) return stateOrder
        return String(b.date ?? "").localeCompare(String(a.date ?? ""))
      })
  }, [completedIds, costCodeNames, costCodesEnabled, expenses, openCosts, timeEntries, vendorBills])

  const needsReviewItems = items.filter((item) => item.tabState === "needs-review")
  const blockedItems = items.filter((item) => item.tabState === "blocked")
  const awaitingClientApprovalItems = items.filter((item) => item.tabState === "awaiting-client-approval")
  const readyToInvoiceItems = items.filter((item) => item.tabState === "ready-to-invoice")
  const billedItems = items.filter((item) => item.tabState === "billed")
  const tabCounts: Record<TabValue, number> = {
    all: items.length,
    "needs-review": needsReviewItems.length,
    blocked: blockedItems.length,
    "awaiting-client-approval": awaitingClientApprovalItems.length,
    "ready-to-invoice": readyToInvoiceItems.length,
    billed: billedItems.length,
  }
  const visibleItems =
    activeTab === "all"
      ? items
      : activeTab === "needs-review"
        ? needsReviewItems
        : activeTab === "blocked"
          ? blockedItems
          : activeTab === "awaiting-client-approval"
            ? awaitingClientApprovalItems
            : activeTab === "ready-to-invoice"
              ? readyToInvoiceItems
              : billedItems
  const pageCount = Math.max(1, Math.ceil(visibleItems.length / REVIEW_QUEUE_PAGE_SIZE))
  const clampedPageIndex = Math.min(pageIndex, pageCount - 1)
  const pagedVisibleItems = visibleItems.slice(
    clampedPageIndex * REVIEW_QUEUE_PAGE_SIZE,
    clampedPageIndex * REVIEW_QUEUE_PAGE_SIZE + REVIEW_QUEUE_PAGE_SIZE,
  )
  const showPagination = visibleItems.length > REVIEW_QUEUE_PAGE_SIZE
  const selectedItems = items.filter((item) => selectedIds.has(item.id))
  const selectedReadyItems = selectedItems.filter(isReady)
  const selectedRejectableItems = selectedItems.filter((item) => item.kind === "time" || item.kind === "expense")
  const selectedAssignableItems = selectedItems.filter((item) => item.canChooseCostCode)
  const selectedInvoiceItems = selectedItems.filter(
    (item) => item.tabState === "ready-to-invoice" && item.kind === "billable_cost",
  )
  const summary = {
    needsReviewCount: needsReviewItems.length,
    blockedCount: blockedItems.length,
    awaitingClientApprovalCount: awaitingClientApprovalItems.length,
    readyToInvoiceCount: readyToInvoiceItems.length,
    readyToInvoiceCents: readyToInvoiceItems.reduce((sum, item) => sum + item.amountCents, 0),
    missingCostCodeCount: items.filter((item) => item.needsCostCode).length,
    missingReceiptCount: items.filter((item) => item.needsReceipt).length,
    missingRateCount: items.filter((item) => item.needsRate).length,
    lateCostCount: items.filter((item) => item.lateToBillingPeriodName).length,
    oldestReadyCostDays: readyToInvoiceItems.reduce((max, item) => Math.max(max, item.ageDays), 0),
  }

  useEffect(() => {
    setPageIndex(0)
  }, [activeTab])

  useEffect(() => {
    if (pageIndex > pageCount - 1) setPageIndex(pageCount - 1)
  }, [pageCount, pageIndex])

  function selectedCostCodeId(item: QueueItem) {
    return chosenCostCodes[item.id] ?? item.initialCostCodeId ?? NO_COST_CODE
  }

  function isReady(item: QueueItem) {
    if (item.tabState === "ready-to-invoice" || item.tabState === "billed") return false
    if (item.blockingReasons.length > 0) return false
    if (item.kind === "time" && item.sourceRecord.status !== "submitted") return false
    if (item.kind === "expense" && item.sourceRecord.status !== "submitted") return false
    if (item.kind === "vendor_bill" && item.sourceRecord.status !== "pending") return false
    if (item.needsRate || item.needsReceipt || item.paidEligible === false) return false
    return !costCodesEnabled || selectedCostCodeId(item) !== NO_COST_CODE
  }

  function toggleSelected(itemId: string, checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (checked) next.add(itemId)
      else next.delete(itemId)
      return next
    })
  }

  function toggleAll(rows: QueueItem[], checked: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current)
      for (const row of rows) {
        if (checked) next.add(row.id)
        else next.delete(row.id)
      }
      return next
    })
  }

  async function performApprove(item: QueueItem) {
    if (!isReady(item)) return
    const costCodeId = selectedCostCodeId(item)
    if (item.kind === "time") {
      unwrapAction(await approveInboxTimeEntryAction(projectId, item.recordId, {
        costCodeId,
        isBillable: item.sourceRecord.is_billable ?? true,
        isOvertime: item.sourceRecord.is_overtime ?? false,
        otMultiplier: item.sourceRecord.ot_multiplier ?? 1.5,
      }))
    }
    if (item.kind === "expense") unwrapAction(await approveInboxExpenseAction(projectId, item.recordId, { costCodeId }))
    if (item.kind === "vendor_bill")
      unwrapAction(await approveInboxVendorBillAction(projectId, item.recordId, {
        costCodeId,
      }))
    setCompletedIds((current) => new Set(current).add(item.id))
    setSelectedIds((current) => {
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
  }

  function approve(item: QueueItem) {
    startTransition(async () => {
      try {
        await performApprove(item)
        toast.success("Approved")
      } catch (error: any) {
        toast.error("Could not approve", { description: error?.message })
      }
    })
  }

  async function performReject(item: QueueItem) {
    if (item.kind === "time") unwrapAction(await rejectInboxTimeEntryAction(projectId, item.recordId))
    if (item.kind === "expense") unwrapAction(await rejectInboxExpenseAction(projectId, item.recordId))
    setCompletedIds((current) => new Set(current).add(item.id))
    setSelectedIds((current) => {
      const next = new Set(current)
      next.delete(item.id)
      return next
    })
  }

  function reject(item: QueueItem) {
    startTransition(async () => {
      try {
        await performReject(item)
        toast.success("Rejected")
      } catch (error: any) {
        toast.error("Could not reject", { description: error?.message })
      }
    })
  }

  function sendClientApproval(item: QueueItem) {
    if (item.kind !== "time") return
    startTransition(async () => {
      try {
        const result = unwrapAction(await sendInboxTimeEntryClientApprovalAction(projectId, item.recordId))
        toast.success("Approval email sent", { description: result.sent_to })
      } catch (error: any) {
        toast.error("Could not send approval email", {
          description: error?.message,
        })
      }
    })
  }

  function approveSelected() {
    if (selectedReadyItems.length === 0) return
    startTransition(async () => {
      try {
        for (const item of selectedReadyItems) {
          await performApprove(item)
        }
        toast.success(`Approved ${selectedReadyItems.length} item${selectedReadyItems.length === 1 ? "" : "s"}`)
      } catch (error: any) {
        toast.error("Could not approve selected items", {
          description: error?.message,
        })
      }
    })
  }

  function rejectSelected() {
    if (selectedRejectableItems.length === 0) return
    startTransition(async () => {
      try {
        for (const item of selectedRejectableItems) {
          await performReject(item)
        }
        toast.success(
          `Rejected ${selectedRejectableItems.length} item${selectedRejectableItems.length === 1 ? "" : "s"}`,
        )
      } catch (error: any) {
        toast.error("Could not reject selected items", {
          description: error?.message,
        })
      }
    })
  }

  function applyBulkCostCode() {
    if (bulkCostCodeId === NO_COST_CODE || selectedAssignableItems.length === 0) return
    setChosenCostCodes((current) => {
      const next = { ...current }
      for (const item of selectedAssignableItems) next[item.id] = bulkCostCodeId
      return next
    })
    toast.success(
      `Cost code applied to ${selectedAssignableItems.length} selected item${selectedAssignableItems.length === 1 ? "" : "s"}`,
    )
  }

  function createBillingPeriod() {
    if (!periodStart || !periodEnd) return
    startTransition(async () => {
      try {
        const period = unwrapAction(await createProjectBillingPeriodAction({
          projectId,
          name: periodName.trim() || undefined,
          periodStart,
          periodEnd,
        }))
        setBillingPeriodId(period.id)
        setPeriodDialogOpen(false)
        setPeriodName("")
        setPeriodStart("")
        setPeriodEnd("")
        toast.success("Billing period created")
        router.refresh()
      } catch (error: any) {
        toast.error("Could not create billing period", {
          description: error?.message,
        })
      }
    })
  }

  function createManualAdjustment() {
    const amountCents = Math.round(Number(adjustmentAmount) * 100)
    if (!Number.isFinite(amountCents) || amountCents === 0) {
      toast.error("Enter a non-zero adjustment amount")
      return
    }
    if (!adjustmentDescription.trim() || !adjustmentReason.trim()) {
      toast.error("Description and reason are required")
      return
    }

    startTransition(async () => {
      try {
        unwrapAction(await createManualBillableAdjustmentAction({
          projectId,
          costCodeId: adjustmentCostCodeId === NO_COST_CODE ? null : adjustmentCostCodeId,
          occurredOn: adjustmentDate,
          description: adjustmentDescription.trim(),
          reason: adjustmentReason.trim(),
          amountCents,
          gmpClassification: adjustmentGmpClassification,
        }))
        setAdjustmentDialogOpen(false)
        setAdjustmentAmount("")
        setAdjustmentDescription("")
        setAdjustmentReason("")
        setAdjustmentCostCodeId(NO_COST_CODE)
        setAdjustmentGmpClassification("inside_gmp")
        toast.success("Adjustment added")
        router.refresh()
      } catch (error: any) {
        toast.error("Could not add adjustment", {
          description: error?.message,
        })
      }
    })
  }

  function createInvoiceFromItems(invoiceItems: QueueItem[]) {
    if (invoiceItems.length === 0) return
    startTransition(async () => {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const costIds = invoiceItems.map((item) => item.recordId)
        const result = unwrapAction(await generateInvoiceFromCostsAction({
          projectId,
          billingPeriodId: billingPeriodId === NO_BILLING_PERIOD ? null : billingPeriodId,
          dateRange: dateRangeForSelectedPeriod(billingPeriods, billingPeriodId, today),
          billableCostIds: costIds,
          groupBy: "cost_code",
          includeAllowanceVariances: false,
          dryRun: true,
        }))
        setInvoicePreview(result)
        setInvoicePreviewCostIds(costIds)
        setOverrideGmpCap(false)
        setIncludeEarnedFee(false)
      } catch (error: any) {
        toast.error("Could not preview invoice", {
          description: error?.message,
        })
      }
    })
  }

  function createInvoiceFromSelected() {
    createInvoiceFromItems(selectedInvoiceItems)
  }

  function confirmInvoiceFromPreview() {
    if (!invoicePreviewCostIds.length) return
    startTransition(async () => {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const result = unwrapAction(await generateInvoiceFromCostsAction({
          projectId,
          billingPeriodId: billingPeriodId === NO_BILLING_PERIOD ? null : billingPeriodId,
          dateRange: dateRangeForSelectedPeriod(billingPeriods, billingPeriodId, today),
          billableCostIds: invoicePreviewCostIds,
          groupBy: "cost_code",
          includeAllowanceVariances: false,
          includeEarnedFee,
          overrideGmpCap,
          dryRun: false,
          idempotencyKey: crypto.randomUUID(),
        }))
        setCompletedIds((current) => {
          const next = new Set(current)
          for (const costId of invoicePreviewCostIds) next.add(`billable_cost:${costId}`)
          return next
        })
        setInvoicePreview(null)
        setInvoicePreviewCostIds([])
        setIncludeEarnedFee(false)
        setOverrideGmpCap(false)
        toast.success("Invoice created from ready costs")
        router.push(
          `/projects/${projectId}/financials/receivables${result.invoiceId ? `?invoice=${result.invoiceId}` : ""}`,
        )
      } catch (error: any) {
        toast.error("Could not create invoice", {
          description: error?.message,
        })
      }
    })
  }

  function openItem(item: QueueItem) {
    const overlay = overlayFor(item)
    if (overlay) {
      setOverlayTarget(overlay)
      return
    }
    const href = workspaceHref(item, projectId)
    if (href) router.push(href)
  }

  function openInvoiceFor(item: QueueItem) {
    if (item.recentInvoice) setOverlayTarget({ kind: "invoice", id: item.recentInvoice.id })
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <ReviewWarnings errors={loadErrors} />
      <ReviewHeader
        summary={summary}
        projectId={projectId}
        billingPeriods={billingPeriods}
        billingPeriodId={billingPeriodId}
        onBillingPeriodChange={setBillingPeriodId}
        onCreatePeriodClick={() => setPeriodDialogOpen(true)}
        onAdjustmentClick={() => setAdjustmentDialogOpen(true)}
      />
      <BulkActionBar
        selectedCount={selectedItems.length}
        readyCount={selectedReadyItems.length}
        rejectableCount={selectedRejectableItems.length}
        assignableCount={selectedAssignableItems.length}
        invoiceCount={selectedInvoiceItems.length}
        invoiceTotalCents={selectedInvoiceItems.reduce((sum, item) => sum + item.amountCents, 0)}
        billingPeriods={billingPeriods}
        billingPeriodId={billingPeriodId}
        costCodes={costCodes}
        bulkCostCodeId={bulkCostCodeId}
        isPending={isPending}
        onBillingPeriodChange={setBillingPeriodId}
        onBulkCostCodeChange={setBulkCostCodeId}
        onApplyBulkCostCode={applyBulkCostCode}
        onApproveSelected={approveSelected}
        onRejectSelected={rejectSelected}
        onCreateInvoice={createInvoiceFromSelected}
        onClearSelection={() => setSelectedIds(new Set())}
      />
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as TabValue)} className="w-full gap-0">
        <TabsList className="h-auto min-h-14 w-full justify-start overflow-x-auto rounded-none border-b bg-transparent p-0">
          <InboxTabTrigger value="all" label="All" count={tabCounts.all} />
          <InboxTabTrigger value="needs-review" label="Needs Review" count={tabCounts["needs-review"]} />
          <InboxTabTrigger value="blocked" label="Blocked" count={tabCounts.blocked} />
          <InboxTabTrigger
            value="awaiting-client-approval"
            label="Client Approval"
            count={tabCounts["awaiting-client-approval"]}
          />
          <InboxTabTrigger value="ready-to-invoice" label="Ready to Bill" count={tabCounts["ready-to-invoice"]} />
          <InboxTabTrigger value="billed" label="Billed" count={tabCounts.billed} />
        </TabsList>
      </Tabs>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueueTable
          items={pagedVisibleItems}
          projectId={projectId}
          costCodes={costCodes}
          costCodesEnabled={costCodesEnabled}
          selectedIds={selectedIds}
          isPending={isPending}
          selectedCostCodeId={selectedCostCodeId}
          isReady={isReady}
          onToggleSelected={toggleSelected}
          onToggleAll={toggleAll}
          onCostCodeChange={(item, value) => {
            setChosenCostCodes((current) => ({ ...current, [item.id]: value }))
          }}
          onApprove={approve}
          onReject={reject}
          onSendClientApproval={sendClientApproval}
          onOpen={openItem}
          onOpenInvoice={openInvoiceFor}
        />
      </div>
      <QueuePagination
        totalCount={visibleItems.length}
        pageCount={pageCount}
        pageIndex={clampedPageIndex}
        pageSize={REVIEW_QUEUE_PAGE_SIZE}
        showPagination={showPagination}
        onPageChange={setPageIndex}
      />
      <ReviewDetailOverlays
        projectId={projectId}
        costCodesEnabled={costCodesEnabled}
        target={overlayTarget}
        onClose={() => setOverlayTarget(null)}
      />
      <InvoicePreviewDialog
        open={!!invoicePreview}
        preview={invoicePreview}
        isPending={isPending}
        onOpenChange={(open) => {
          if (!open) {
            setInvoicePreview(null)
            setInvoicePreviewCostIds([])
            setOverrideGmpCap(false)
            setIncludeEarnedFee(false)
          }
        }}
        overrideGmpCap={overrideGmpCap}
        onOverrideGmpCapChange={setOverrideGmpCap}
        feeSummary={feeSummary}
        includeEarnedFee={includeEarnedFee}
        onIncludeEarnedFeeChange={setIncludeEarnedFee}
        onConfirm={confirmInvoiceFromPreview}
      />
      <Dialog open={adjustmentDialogOpen} onOpenChange={setAdjustmentDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Manual billable adjustment</DialogTitle>
            <DialogDescription>Add a controller-approved credit or charge to the billable-cost ledger.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="adjustment-amount">Amount</Label>
                <Input
                  id="adjustment-amount"
                  inputMode="decimal"
                  value={adjustmentAmount}
                  onChange={(event) => setAdjustmentAmount(event.target.value)}
                  placeholder="-250.00"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="adjustment-date">Date</Label>
                <Input
                  id="adjustment-date"
                  type="date"
                  value={adjustmentDate}
                  onChange={(event) => setAdjustmentDate(event.target.value)}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Cost code</Label>
                <Select value={adjustmentCostCodeId} onValueChange={setAdjustmentCostCodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Cost code" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_COST_CODE}>Uncoded</SelectItem>
                    {costCodes.map((code) => (
                      <SelectItem key={code.id} value={code.id}>
                        {formatCostCode(code)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>GMP class</Label>
                <Select
                  value={adjustmentGmpClassification}
                  onValueChange={(value) => setAdjustmentGmpClassification(value as "inside_gmp" | "outside_gmp")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inside_gmp">Inside GMP</SelectItem>
                    <SelectItem value="outside_gmp">Outside GMP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="adjustment-description">Description</Label>
              <Input
                id="adjustment-description"
                value={adjustmentDescription}
                onChange={(event) => setAdjustmentDescription(event.target.value)}
                placeholder="Courtesy credit"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="adjustment-reason">Reason</Label>
              <Textarea
                id="adjustment-reason"
                value={adjustmentReason}
                onChange={(event) => setAdjustmentReason(event.target.value)}
                placeholder="Why this adjustment is being added"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={isPending} onClick={() => setAdjustmentDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={isPending} onClick={createManualAdjustment}>
              Add adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={periodDialogOpen} onOpenChange={setPeriodDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New billing period</DialogTitle>
            <DialogDescription>Create a period for approved-cost billing.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="billing-period-name">Name</Label>
              <Input
                id="billing-period-name"
                value={periodName}
                onChange={(event) => setPeriodName(event.target.value)}
                placeholder="June 2026"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="billing-period-start">Start</Label>
                <Input
                  id="billing-period-start"
                  type="date"
                  value={periodStart}
                  onChange={(event) => setPeriodStart(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="billing-period-end">End</Label>
                <Input
                  id="billing-period-end"
                  type="date"
                  value={periodEnd}
                  onChange={(event) => setPeriodEnd(event.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={isPending} onClick={() => setPeriodDialogOpen(false)}>
              Cancel
            </Button>
            <Button disabled={isPending || !periodStart || !periodEnd} onClick={createBillingPeriod}>
              Create period
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function InvoicePreviewDialog({
  open,
  preview,
  isPending,
  overrideGmpCap,
  onOverrideGmpCapChange,
  feeSummary,
  includeEarnedFee,
  onIncludeEarnedFeeChange,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  preview: any | null
  isPending: boolean
  overrideGmpCap: boolean
  onOverrideGmpCapChange: (checked: boolean) => void
  feeSummary?: ProjectFeeBillingSummary | null
  includeEarnedFee: boolean
  onIncludeEarnedFeeChange: (checked: boolean) => void
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const lines = preview?.invoicePreview?.lines ?? []
  const billableFeeCents = Math.max(0, Number(feeSummary?.billable_fee_cents ?? 0))
  const canIncludeEarnedFee = Boolean(feeSummary?.enabled && billableFeeCents > 0)
  const hasEarnedFeeLine = lines.some((line: any) => line?.metadata?.fee_line_kind === "fixed_fee_earned")
  const earnedFeePreviewLine = {
    description: "Construction management fee",
    unit: "fee",
    cost_cents: 0,
    markup_cents: 0,
    billable_cents: billableFeeCents,
    billable_cost_ids: [],
    metadata: { fee_line_kind: "fixed_fee_earned" },
  }
  const displayLines =
    includeEarnedFee && canIncludeEarnedFee && !hasEarnedFeeLine
      ? insertBeforeRetainage(lines, earnedFeePreviewLine)
      : lines
  const previewTotalCents = Number(preview?.totalBillableCents ?? preview?.invoicePreview?.totals?.billable_cents ?? 0)
  const displayTotalCents =
    includeEarnedFee && canIncludeEarnedFee && !hasEarnedFeeLine
      ? previewTotalCents + billableFeeCents
      : previewTotalCents
  const gmpWarning = (preview?.warnings ?? []).find((warning: any) => warning.code === "gmp_cap_exceeded")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Preview ready-cost invoice</DialogTitle>
          <DialogDescription>
            Review the grouped invoice lines before creating the draft in Receivables.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-auto border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead className="text-right">Base</TableHead>
                <TableHead className="text-right">Markup</TableHead>
                <TableHead className="text-right">Billable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayLines.map((line: any, index: number) => (
                <TableRow key={`${line.description}-${index}`}>
                  <TableCell>
                    <div className="font-medium">{line.description}</div>
                    <div className="text-xs text-muted-foreground">
                      {line.unit === "fee" ? "Fee" : `${line.billable_cost_ids?.length ?? 0} cost(s)`}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">{formatCurrency(line.cost_cents ?? 0)}</TableCell>
                  <TableCell className="text-right">{formatCurrency(line.markup_cents ?? 0)}</TableCell>
                  <TableCell className="text-right font-medium">{formatCurrency(line.billable_cents ?? 0)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{preview?.costCount ?? 0} approved cost(s)</span>
          <span className="font-semibold">{formatCurrency(displayTotalCents)}</span>
        </div>
        {canIncludeEarnedFee ? (
          <label className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm">
            <span>
              <span className="font-medium">Include earned fee</span>
              <span className="ml-2 text-muted-foreground">{formatCurrency(billableFeeCents)}</span>
            </span>
            <Checkbox
              checked={includeEarnedFee}
              onCheckedChange={(checked) => onIncludeEarnedFeeChange(checked === true)}
            />
          </label>
        ) : null}
        {gmpWarning ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <div className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-3">
                <p>{gmpWarning.message}</p>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={overrideGmpCap}
                    onCheckedChange={(checked) => onOverrideGmpCapChange(checked === true)}
                  />
                  Bill anyway
                </label>
              </div>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={isPending || displayLines.length === 0 || Boolean(gmpWarning && !overrideGmpCap)}
            onClick={onConfirm}
          >
            Create draft invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function insertBeforeRetainage(lines: any[], lineToInsert: any) {
  const retainageIndex = lines.findIndex(
    (line) => line.unit === "retainage" || line?.metadata?.system_generated_kind === "retainage_hold",
  )
  if (retainageIndex === -1) return [...lines, lineToInsert]
  return [...lines.slice(0, retainageIndex), lineToInsert, ...lines.slice(retainageIndex)]
}

function InboxTabTrigger({ value, label, count }: { value: TabValue; label: string; count: number }) {
  return (
    <TabsTrigger
      value={value}
      className="h-14 gap-2 rounded-none border-0 px-3.5 text-muted-foreground shadow-none transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-0 data-[state=active]:bg-transparent data-[state=active]:font-semibold data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {label}
      <Badge variant="secondary" className="h-5 rounded-sm px-1.5 text-[10px]">
        {count}
      </Badge>
    </TabsTrigger>
  )
}

function ReviewWarnings({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-8 dark:border-amber-900/30 dark:bg-amber-950/35 dark:text-amber-200">
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

function ReviewHeader({
  summary,
  projectId,
  billingPeriods,
  billingPeriodId,
  onBillingPeriodChange,
  onCreatePeriodClick,
  onAdjustmentClick,
}: {
  summary: {
    needsReviewCount: number
    blockedCount: number
    awaitingClientApprovalCount: number
    readyToInvoiceCount: number
    readyToInvoiceCents: number
    missingCostCodeCount: number
    missingReceiptCount: number
    missingRateCount: number
    lateCostCount: number
    oldestReadyCostDays: number
  }
  projectId: string
  billingPeriods: BillingPeriodOption[]
  billingPeriodId: string
  onBillingPeriodChange: (value: string) => void
  onCreatePeriodClick: () => void
  onAdjustmentClick: () => void
}) {
  const selected = billingPeriods.find((period) => period.id === billingPeriodId)

  return (
    <div className="flex flex-col gap-4 border-b bg-background px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Ready to bill</span>
          <span className="text-xl font-semibold tabular-nums">{formatCurrency(summary.readyToInvoiceCents)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
          <span>Oldest unbilled {summary.oldestReadyCostDays || 0}d</span>
          <span aria-hidden className="text-border">·</span>
          <span>{summary.needsReviewCount} needs review</span>
          <span aria-hidden className="text-border">·</span>
          <span>{summary.blockedCount} blocked</span>
          <span aria-hidden className="text-border">·</span>
          <span>{summary.awaitingClientApprovalCount} client approval</span>
          {summary.blockedCount > 0 ? (
            <span className="text-amber-700 dark:text-amber-400">{formatBlockerDetail(summary)}</span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={billingPeriodId}
          onValueChange={(value) => {
            if (value === NEW_BILLING_PERIOD) {
              onCreatePeriodClick()
              return
            }
            onBillingPeriodChange(value)
          }}
        >
          <SelectTrigger className="h-9 w-[220px] bg-background">
            <SelectValue placeholder="Billing period" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_BILLING_PERIOD}>
              <span className="flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" />
                New period
              </span>
            </SelectItem>
            <SelectSeparator />
            <SelectItem value={NO_BILLING_PERIOD}>No period</SelectItem>
            {billingPeriods.map((period) => (
              <SelectItem
                key={period.id}
                value={period.id}
                disabled={period.status === "closed" || period.status === "invoiced"}
              >
                {period.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selected ? (
          <Badge variant="outline" className="capitalize">
            {selected.status}
          </Badge>
        ) : null}
        <Button size="sm" variant="outline" onClick={onAdjustmentClick}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Adjustment
        </Button>
        <Button size="sm" asChild>
          <Link href={`/projects/${projectId}/financials/receivables?tab=close`}>Close &amp; Bill</Link>
        </Button>
      </div>
    </div>
  )
}

function BulkActionBar({
  selectedCount,
  readyCount,
  rejectableCount,
  assignableCount,
  invoiceCount,
  invoiceTotalCents,
  billingPeriods,
  billingPeriodId,
  costCodes,
  bulkCostCodeId,
  isPending,
  onBillingPeriodChange,
  onBulkCostCodeChange,
  onApplyBulkCostCode,
  onApproveSelected,
  onRejectSelected,
  onCreateInvoice,
  onClearSelection,
}: {
  selectedCount: number
  readyCount: number
  rejectableCount: number
  assignableCount: number
  invoiceCount: number
  invoiceTotalCents: number
  billingPeriods: BillingPeriodOption[]
  billingPeriodId: string
  costCodes: CostCodeOption[]
  bulkCostCodeId: string
  isPending: boolean
  onBillingPeriodChange: (value: string) => void
  onBulkCostCodeChange: (value: string) => void
  onApplyBulkCostCode: () => void
  onApproveSelected: () => void
  onRejectSelected: () => void
  onCreateInvoice: () => void
  onClearSelection: () => void
}) {
  if (selectedCount === 0) return null

  return (
    <div className="flex flex-col gap-3 border-b bg-muted/30 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
      <div className="text-sm">
        <span className="font-medium">{selectedCount}</span> selected
        {invoiceCount > 0 ? (
          <span className="ml-2 text-muted-foreground">{formatCurrency(invoiceTotalCents)} ready</span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {assignableCount > 0 ? (
          <>
            <Select value={bulkCostCodeId} onValueChange={onBulkCostCodeChange}>
              <SelectTrigger className="h-9 w-[220px] bg-background">
                <SelectValue placeholder="Bulk cost code" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COST_CODE}>Choose cost code</SelectItem>
                {costCodes.map((code) => (
                  <SelectItem key={code.id} value={code.id}>
                    {formatCostCode(code)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={isPending || bulkCostCodeId === NO_COST_CODE}
              onClick={onApplyBulkCostCode}
            >
              Apply code
            </Button>
          </>
        ) : null}
        {invoiceCount > 0 ? (
          <Select value={billingPeriodId} onValueChange={onBillingPeriodChange}>
            <SelectTrigger className="h-9 w-[240px] bg-background">
              <SelectValue placeholder="Billing period" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_BILLING_PERIOD}>No period</SelectItem>
              {billingPeriods.map((period) => (
                <SelectItem
                  key={period.id}
                  value={period.id}
                  disabled={period.status === "closed" || period.status === "invoiced"}
                >
                  {period.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button variant="outline" size="sm" disabled={isPending || readyCount === 0} onClick={onApproveSelected}>
          Approve selected
        </Button>
        <Button variant="outline" size="sm" disabled={isPending || rejectableCount === 0} onClick={onRejectSelected}>
          Reject selected
        </Button>
        <Button size="sm" disabled={isPending || invoiceCount === 0} onClick={onCreateInvoice}>
          Create invoice
        </Button>
        <Button variant="ghost" size="sm" disabled={isPending} onClick={onClearSelection}>
          Clear
        </Button>
      </div>
    </div>
  )
}

function QueuePagination({
  totalCount,
  pageCount,
  pageIndex,
  pageSize,
  showPagination,
  onPageChange,
}: {
  totalCount: number
  pageCount: number
  pageIndex: number
  pageSize: number
  showPagination: boolean
  onPageChange: (pageIndex: number) => void
}) {
  const start = totalCount === 0 ? 0 : pageIndex * pageSize + 1
  const end = Math.min(totalCount, (pageIndex + 1) * pageSize)

  return (
    <div className="flex shrink-0 flex-col gap-2 border-x border-b bg-background px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>
        Showing {start}-{end} of {totalCount}
      </span>
      {showPagination ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pageIndex <= 0}
            onClick={() => onPageChange(Math.max(0, pageIndex - 1))}
          >
            Previous
          </Button>
          <span>
            Page {pageIndex + 1} of {pageCount}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pageIndex >= pageCount - 1}
            onClick={() => onPageChange(Math.min(pageCount - 1, pageIndex + 1))}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function QueueTable({
  items,
  projectId,
  costCodes,
  costCodesEnabled,
  selectedIds,
  isPending,
  selectedCostCodeId,
  isReady,
  onToggleSelected,
  onToggleAll,
  onCostCodeChange,
  onApprove,
  onReject,
  onSendClientApproval,
  onOpen,
  onOpenInvoice,
}: {
  items: QueueItem[]
  projectId: string
  costCodes: CostCodeOption[]
  costCodesEnabled: boolean
  selectedIds: Set<string>
  isPending: boolean
  selectedCostCodeId: (item: QueueItem) => string
  isReady: (item: QueueItem) => boolean
  onToggleSelected: (itemId: string, checked: boolean) => void
  onToggleAll: (items: QueueItem[], checked: boolean) => void
  onCostCodeChange: (item: QueueItem, value: string) => void
  onApprove: (item: QueueItem) => void
  onReject: (item: QueueItem) => void
  onSendClientApproval: (item: QueueItem) => void
  onOpen: (item: QueueItem) => void
  onOpenInvoice: (item: QueueItem) => void
}) {
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id))
  const partiallySelected = !allSelected && items.some((item) => selectedIds.has(item.id))

  if (items.length === 0) {
    return (
      <div className="border-x border-b">
        <Empty className="border-0 py-16">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CheckCircle2 className="h-6 w-6 text-success" />
            </EmptyMedia>
            <EmptyTitle>All clear</EmptyTitle>
            <EmptyDescription>Nothing in this queue. New costs land here as they come in.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="w-full overflow-x-auto">
      <Table className={cn("border border-border", costCodesEnabled ? "min-w-[940px]" : "min-w-[800px]")}>
        <TableHeader>
          <TableRow className="border-b">
            <TableHead className="w-14 border-r p-0 text-center align-middle">
              <div className="flex h-full min-h-10 items-center justify-center">
                <Checkbox
                  checked={allSelected || (partiallySelected ? "indeterminate" : false)}
                  onCheckedChange={(checked) => onToggleAll(items, checked === true)}
                  aria-label="Select all rows"
                />
              </div>
            </TableHead>
            <TableHead className="border-r">Item</TableHead>
            {costCodesEnabled ? <TableHead className="w-[340px] border-r">Cost code</TableHead> : null}
            <TableHead className="w-[140px] border-r text-right">Date</TableHead>
            <TableHead className="w-[110px] border-r text-center">Age</TableHead>
            <TableHead className="w-[150px] border-r text-right">Amount</TableHead>
            <TableHead className="w-28 text-center" colSpan={2}>
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const ready = isReady(item)
            const canOpen = itemHasTarget(item, projectId)
            const hasInvoice = Boolean(item.recentInvoice)
            const opensInvoice = overlayFor(item)?.kind === "invoice"
            return (
              <TableRow
                key={item.id}
                data-state={selectedIds.has(item.id) ? "selected" : undefined}
                className={cn("h-14 border-b", canOpen && "cursor-pointer")}
                onClick={canOpen ? () => onOpen(item) : undefined}
              >
                <TableCell
                  className="border-r p-0 text-center align-middle"
                  onClick={(event) => event.stopPropagation()}
                >
                  <div className="flex h-14 items-center justify-center">
                    <Checkbox
                      checked={selectedIds.has(item.id)}
                      onCheckedChange={(checked) => onToggleSelected(item.id, checked === true)}
                      aria-label={`Select ${item.source}`}
                    />
                  </div>
                </TableCell>
                <TableCell className="border-r">
                  <div className="flex items-start gap-2">
                    <KindIcon kind={item.kind} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{item.description}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                        <span className="text-foreground/70">{item.typeLabel}</span>
                        <span aria-hidden className="text-border">·</span>
                        <span className="truncate">{item.source}</span>
                        {item.billingPeriodName ? (
                          <>
                            <span aria-hidden className="text-border">·</span>
                            <span>{item.billingPeriodName}</span>
                          </>
                        ) : null}
                        {item.lateToBillingPeriodName ? (
                          <span className="text-amber-700 dark:text-amber-400">
                            Late to {item.lateToBillingPeriodName}
                          </span>
                        ) : null}
                        {item.recentInvoice ? (
                          <button
                            type="button"
                            className="text-foreground underline-offset-2 hover:underline"
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpenInvoice(item)
                            }}
                          >
                            {item.recentInvoice.invoice_number ?? "Invoice"}
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </TableCell>
                {costCodesEnabled ? (
                  <TableCell className="border-r p-0" onClick={(event) => event.stopPropagation()}>
                    {item.canChooseCostCode ? (
                      <Select value={selectedCostCodeId(item)} onValueChange={(value) => onCostCodeChange(item, value)}>
                        <SelectTrigger className="h-14 w-full rounded-none border-0 bg-transparent px-3 shadow-none focus:ring-0">
                          <SelectValue placeholder="Choose One" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NO_COST_CODE}>Choose One</SelectItem>
                          {costCodes.map((code) => (
                            <SelectItem key={code.id} value={code.id}>
                              {formatCostCode(code)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="flex h-14 items-center px-3 text-sm text-muted-foreground">
                        {item.initialCostCodeLabel}
                      </span>
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="border-r text-right tabular-nums text-muted-foreground">
                  {formatDate(item.date)}
                </TableCell>
                <TableCell className="border-r text-center">
                  <AgeBadge days={item.ageDays} muted={item.kind !== "billable_cost" || item.tabState === "billed"} />
                </TableCell>
                <TableCell className="border-r text-right font-medium tabular-nums">
                  {formatCurrency(item.amountCents)}
                </TableCell>
                <TableCell className="w-14 border-r p-0 text-center" onClick={(event) => event.stopPropagation()}>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className={cn(
                      "h-8 w-8 rounded-md",
                      ready
                        ? "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 hover:text-white"
                        : "border-muted bg-muted text-muted-foreground opacity-70",
                    )}
                    disabled={isPending || !ready}
                    title={ready ? "Approve" : disabledReason(item, selectedCostCodeId(item), costCodesEnabled)}
                    onClick={() => onApprove(item)}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                </TableCell>
                <TableCell className="w-14 p-0 text-center" onClick={(event) => event.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" size="icon" variant="ghost" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      {canOpen && !opensInvoice ? (
                        <DropdownMenuItem onClick={() => onOpen(item)}>
                          <ExternalLink className="h-4 w-4" />
                          {openLabel(item)}
                        </DropdownMenuItem>
                      ) : null}
                      {hasInvoice ? (
                        <DropdownMenuItem onClick={() => onOpenInvoice(item)}>
                          <FileText className="h-4 w-4" />
                          View invoice
                        </DropdownMenuItem>
                      ) : null}
                      {ready ? (
                        <DropdownMenuItem disabled={isPending} onClick={() => onApprove(item)}>
                          <Check className="h-4 w-4" />
                          Approve
                        </DropdownMenuItem>
                      ) : null}
                      {item.kind === "time" && item.sourceRecord.status === "pm_approved" ? (
                        <DropdownMenuItem disabled={isPending} onClick={() => onSendClientApproval(item)}>
                          <Timer className="h-4 w-4" />
                          Send for client approval
                        </DropdownMenuItem>
                      ) : null}
                      {item.kind === "time" || item.kind === "expense" ? (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            disabled={isPending}
                            onClick={() => onReject(item)}
                          >
                            <X className="h-4 w-4" />
                            Reject
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function KindIcon({ kind, className }: { kind: QueueKind; className?: string }) {
  const Icon = kind === "time" ? Timer : kind === "expense" ? ReceiptText : kind === "vendor_bill" ? CreditCard : FileText
  return <Icon className={className} />
}

/** Deep link to the underlying record's own workbench, with that record selected. */
function workspaceHref(item: QueueItem, projectId: string): string | null {
  switch (item.kind) {
    case "expense":
      return `/projects/${projectId}/expenses?expense=${item.recordId}`
    case "vendor_bill":
      return `/projects/${projectId}/financials/payables?bill=${item.recordId}`
    case "time":
      return `/projects/${projectId}/time`
    case "billable_cost": {
      const sourceType = item.sourceRecord?.source_type
      const sourceId = item.sourceRecord?.source_id
      if (sourceType === "project_expense" && sourceId) return `/projects/${projectId}/expenses?expense=${sourceId}`
      if (sourceType === "time_entry") return `/projects/${projectId}/time`
      if (sourceType === "vendor_bill_line") return `/projects/${projectId}/financials/payables`
      return null
    }
    default:
      return null
  }
}

/** The in-place detail overlay a row opens, if any (expense/bill workspace or invoice sheet). */
function overlayFor(item: QueueItem): ReviewOverlayTarget | null {
  switch (item.kind) {
    case "expense":
      return { kind: "expense", id: item.recordId }
    case "vendor_bill":
      return { kind: "vendor_bill", id: item.recordId }
    case "billable_cost": {
      if (item.recentInvoice) return { kind: "invoice", id: item.recentInvoice.id }
      const sourceType = item.sourceRecord?.source_type
      const sourceId = item.sourceRecord?.source_id
      if (sourceType === "project_expense" && sourceId) return { kind: "expense", id: sourceId }
      return null
    }
    default:
      return null
  }
}

/** Whether a row is openable at all — via in-place overlay or navigation fallback (time). */
function itemHasTarget(item: QueueItem, projectId: string): boolean {
  return Boolean(overlayFor(item) || workspaceHref(item, projectId))
}

function openLabel(item: QueueItem): string {
  switch (item.kind) {
    case "expense":
      return "Open expense"
    case "vendor_bill":
      return "Open bill"
    case "time":
      return "Open time entry"
    default:
      return "Open source"
  }
}

function AgeBadge({ days, muted }: { days: number; muted?: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "min-w-14 justify-center rounded-sm px-1.5 text-[10px] tabular-nums",
        muted && "border-muted text-muted-foreground",
        !muted && days > 60 && "border-destructive/30 bg-destructive/10 text-destructive",
        !muted && days > 30 && days <= 60 && "border-amber-500/30 bg-amber-500/10 text-amber-700",
      )}
    >
      {days}d
    </Badge>
  )
}

function disabledReason(item: QueueItem, selectedCostCodeId: string, costCodesEnabled = true) {
  if (item.blockingReasons.length > 0) return item.blockingReasons[0] ?? "Blocked"
  if (item.tabState === "ready-to-invoice") return "Ready to bill"
  if (item.tabState === "billed") return "Billed"
  if (item.kind === "time" && item.sourceRecord.status !== "submitted") return "Waiting on client approval"
  if (item.kind === "expense" && item.sourceRecord.status !== "submitted") return "Submit expense before approving"
  if (item.kind === "vendor_bill" && item.sourceRecord.status !== "pending") return "Bill is not pending"
  if (costCodesEnabled && selectedCostCodeId === NO_COST_CODE) return "Choose a cost code"
  if (item.needsRate) return "Set a rate from the time entry"
  if (item.needsReceipt) return "Add a receipt before approving"
  if (item.paidEligible === false) return "Paid-cost rule is not met"
  return ""
}

function formatCostCode(code: CostCodeOption) {
  return `${code.code ?? ""} ${code.name ?? ""}`.trim() || "Cost code"
}

function summarizeBillCostCodes(bill: VendorBillSummary) {
  const lines = bill.actual_lines ?? []
  const codes = Array.from(new Set(lines.map((line) => line.cost_code_code).filter(Boolean)))
  if (codes.length === 0) return "Choose One"
  if (codes.length === 1) return codes[0] ?? "Coded"
  return `${codes.length} codes`
}

function formatSourceType(sourceType?: string | null) {
  return String(sourceType ?? "Cost")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function stateRank(state: QueueItem["tabState"]) {
  if (state === "blocked") return 0
  if (state === "needs-review") return 1
  if (state === "awaiting-client-approval") return 2
  if (state === "ready-to-invoice") return 3
  return 4
}

function dateRangeForSelectedPeriod(periods: BillingPeriodOption[], billingPeriodId: string, today: string) {
  const period = periods.find((item) => item.id === billingPeriodId)
  if (!period) return { from: "1970-01-01", to: today }
  return { from: period.period_start, to: period.period_end }
}

function formatBlockerDetail(summary: {
  missingCostCodeCount: number
  missingReceiptCount: number
  missingRateCount: number
}) {
  const parts = [
    summary.missingCostCodeCount > 0 ? `${summary.missingCostCodeCount} code` : null,
    summary.missingReceiptCount > 0 ? `${summary.missingReceiptCount} receipt` : null,
    summary.missingRateCount > 0 ? `${summary.missingRateCount} rate` : null,
  ].filter(Boolean)
  return parts.length > 0 ? `Missing ${parts.join(", ")}` : "No blockers"
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function formatDate(value?: string | null) {
  if (!value) return "No date"
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  })
}

function ageDays(value?: string | null) {
  if (!value) return 0
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return 0
  const today = new Date()
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const thenUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.max(0, Math.floor((todayUtc - thenUtc) / 86_400_000))
}
