"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { AlertTriangle, Check, CreditCard, ExternalLink, FileText, MoreHorizontal, ReceiptText, Timer, X } from "lucide-react"

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  approveInboxExpenseAction,
  approveInboxTimeEntryAction,
  approveInboxVendorBillAction,
  rejectInboxExpenseAction,
  rejectInboxTimeEntryAction,
  sendInboxTimeEntryClientApprovalAction,
} from "@/app/(app)/projects/[id]/cost-inbox/actions"
import { generateInvoiceFromCostsAction } from "@/app/(app)/projects/[id]/financials/actions"
import { cn } from "@/lib/utils"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"

interface CostCodeOption {
  id: string
  code?: string | null
  name?: string | null
}

interface ReviewQueueTableProps {
  projectId: string
  timeEntries: any[]
  expenses: any[]
  vendorBills: VendorBillSummary[]
  openCosts: any[]
  costCodes: CostCodeOption[]
  loadErrors?: string[]
}

type QueueState = "needs-review" | "blocked" | "awaiting-client-approval" | "ready-to-invoice" | "billed"
type QueueKind = "time" | "expense" | "vendor_bill" | "billable_cost"
type TabValue = "all" | "needs-review" | "blocked" | "awaiting-client-approval" | "ready-to-invoice"

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
  href: string
  initialCostCodeId?: string | null
  initialCostCodeLabel: string
  needsCostCode: boolean
  needsRate?: boolean
  needsReceipt?: boolean
  canChooseCostCode: boolean
  sourceRecord: any
}

const NO_COST_CODE = "__none__"

export function ReviewQueueTable({
  projectId,
  timeEntries,
  expenses,
  vendorBills,
  openCosts,
  costCodes,
  loadErrors = [],
}: ReviewQueueTableProps) {
  const router = useRouter()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [chosenCostCodes, setChosenCostCodes] = useState<Record<string, string>>({})
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => new Set())
  const [detailItem, setDetailItem] = useState<QueueItem | null>(null)
  const [bulkCostCodeId, setBulkCostCodeId] = useState<string>(NO_COST_CODE)
  const [activeTab, setActiveTab] = useState<TabValue>("needs-review")
  const [invoicePreview, setInvoicePreview] = useState<any | null>(null)
  const [invoicePreviewCostIds, setInvoicePreviewCostIds] = useState<string[]>([])
  const [isPending, startTransition] = useTransition()

  const costCodeNames = useMemo(() => new Map(costCodes.map((code) => [code.id, formatCostCode(code)])), [costCodes])

  const items = useMemo(() => {
    const rows: QueueItem[] = []

    for (const entry of timeEntries) {
      const missingRate = Number(entry.base_rate_cents ?? 0) <= 0
      const missingCostCode = !entry.cost_code_id
      rows.push({
        id: `time:${entry.id}`,
        recordId: entry.id,
        kind: "time",
        tabState: entry.status === "pm_approved" ? "awaiting-client-approval" : missingRate || missingCostCode ? "blocked" : "needs-review",
        typeLabel: "Time",
        source: entry.worker_name ?? "Crew time",
        description: entry.notes || `${Number(entry.hours ?? 0).toFixed(2)} hours`,
        amountCents: Number(entry.cost_cents ?? 0),
        date: entry.work_date,
        href: `/projects/${projectId}/time`,
        initialCostCodeId: entry.cost_code_id ?? null,
        initialCostCodeLabel: entry.cost_code_id ? costCodeNames.get(entry.cost_code_id) ?? "Cost code" : "Choose One",
        needsCostCode: missingCostCode,
        needsRate: missingRate,
        needsReceipt: false,
        canChooseCostCode: true,
        sourceRecord: entry,
      })
    }

    for (const expense of expenses) {
      const missingCostCode = !expense.cost_code_id
      const missingReceipt = !expense.receipt_file_id
      rows.push({
        id: `expense:${expense.id}`,
        recordId: expense.id,
        kind: "expense",
        tabState: expense.status === "draft" || missingCostCode || missingReceipt ? "blocked" : "needs-review",
        typeLabel: "Expense",
        source: expense.vendor_company?.name ?? expense.vendor_name_text ?? "Expense",
        description: expense.description ?? "Project expense",
        amountCents: Number(expense.amount_cents ?? 0) + Number(expense.tax_cents ?? 0),
        date: expense.expense_date,
        href: `/projects/${projectId}/expenses`,
        initialCostCodeId: expense.cost_code_id ?? null,
        initialCostCodeLabel: expense.cost_code?.code ? `${expense.cost_code.code} ${expense.cost_code.name ?? ""}`.trim() : "Choose One",
        needsCostCode: missingCostCode,
        needsRate: false,
        needsReceipt: missingReceipt,
        canChooseCostCode: true,
        sourceRecord: expense,
      })
    }

    for (const bill of vendorBills) {
      const actualLines = bill.actual_lines ?? []
      const firstLine = actualLines[0]
      const hasMultipleLines = actualLines.length > 1
      const isCoded = actualLines.length > 0 && actualLines.every((line) => Boolean(line.cost_code_id))
      rows.push({
        id: `vendor_bill:${bill.id}`,
        recordId: bill.id,
        kind: "vendor_bill",
        tabState: isCoded ? "needs-review" : "blocked",
        typeLabel: "Vendor Bill",
        source: bill.company_name ?? "Vendor",
        description: bill.bill_number ?? bill.commitment_title ?? "Vendor bill",
        amountCents: Number(bill.total_cents ?? 0),
        date: bill.due_date ?? bill.bill_date,
        href: `/projects/${projectId}/financials/payables`,
        initialCostCodeId: firstLine?.cost_code_id ?? null,
        initialCostCodeLabel: isCoded ? summarizeBillCostCodes(bill) : "Choose One",
        needsCostCode: !isCoded,
        needsRate: false,
        needsReceipt: false,
        canChooseCostCode: !hasMultipleLines,
        sourceRecord: bill,
      })
    }

    for (const cost of openCosts) {
      rows.push({
        id: `billable_cost:${cost.id}`,
        recordId: cost.id,
        kind: "billable_cost",
        tabState: "ready-to-invoice",
        typeLabel: "Billable Cost",
        source: formatSourceType(cost.source_type),
        description: cost.description ?? "Billable cost",
        amountCents: Number(cost.billable_cents ?? 0),
        date: cost.occurred_on,
        href: `/projects/${projectId}/financials/receivables`,
        initialCostCodeId: cost.cost_code_id ?? null,
        initialCostCodeLabel: cost.cost_code_code ? `${cost.cost_code_code} ${cost.cost_code_name ?? ""}`.trim() : "Choose One",
        needsCostCode: false,
        needsRate: false,
        needsReceipt: false,
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
  }, [completedIds, costCodeNames, expenses, openCosts, projectId, timeEntries, vendorBills])

  const needsReviewItems = items.filter((item) => item.tabState === "needs-review")
  const blockedItems = items.filter((item) => item.tabState === "blocked")
  const awaitingClientApprovalItems = items.filter((item) => item.tabState === "awaiting-client-approval")
  const readyToInvoiceItems = items.filter((item) => item.tabState === "ready-to-invoice")
  const tabCounts: Record<TabValue, number> = {
    all: items.length,
    "needs-review": needsReviewItems.length,
    blocked: blockedItems.length,
    "awaiting-client-approval": awaitingClientApprovalItems.length,
    "ready-to-invoice": readyToInvoiceItems.length,
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
            : readyToInvoiceItems
  const selectedItems = items.filter((item) => selectedIds.has(item.id))
  const selectedReadyItems = selectedItems.filter(isReady)
  const selectedRejectableItems = selectedItems.filter((item) => item.kind === "time" || item.kind === "expense")
  const selectedAssignableItems = selectedItems.filter((item) => item.canChooseCostCode)
  const selectedInvoiceItems = selectedItems.filter((item) => item.tabState === "ready-to-invoice" && item.kind === "billable_cost")
  const summary = {
    needsReviewCount: needsReviewItems.length,
    blockedCount: blockedItems.length,
    awaitingClientApprovalCount: awaitingClientApprovalItems.length,
    readyToInvoiceCount: readyToInvoiceItems.length,
    readyToInvoiceCents: readyToInvoiceItems.reduce((sum, item) => sum + item.amountCents, 0),
    missingCostCodeCount: items.filter((item) => item.needsCostCode).length,
    missingReceiptCount: items.filter((item) => item.needsReceipt).length,
    missingRateCount: items.filter((item) => item.needsRate).length,
  }

  function selectedCostCodeId(item: QueueItem) {
    return chosenCostCodes[item.id] ?? item.initialCostCodeId ?? NO_COST_CODE
  }

  function isReady(item: QueueItem) {
    if (item.tabState === "ready-to-invoice" || item.tabState === "billed") return false
    if (item.kind === "time" && item.sourceRecord.status !== "submitted") return false
    if (item.kind === "expense" && item.sourceRecord.status !== "submitted") return false
    if (item.kind === "vendor_bill" && item.sourceRecord.status !== "pending") return false
    if (item.needsRate || item.needsReceipt) return false
    return selectedCostCodeId(item) !== NO_COST_CODE
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
      await approveInboxTimeEntryAction(projectId, item.recordId, {
        costCodeId,
        isBillable: item.sourceRecord.is_billable ?? true,
        isOvertime: item.sourceRecord.is_overtime ?? false,
      })
    }
    if (item.kind === "expense") await approveInboxExpenseAction(projectId, item.recordId, { costCodeId })
    if (item.kind === "vendor_bill") await approveInboxVendorBillAction(projectId, item.recordId, { costCodeId })
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
    if (item.kind === "time") await rejectInboxTimeEntryAction(projectId, item.recordId)
    if (item.kind === "expense") await rejectInboxExpenseAction(projectId, item.recordId)
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
        const result = await sendInboxTimeEntryClientApprovalAction(projectId, item.recordId)
        toast.success("Approval email sent", { description: result.sent_to })
      } catch (error: any) {
        toast.error("Could not send approval email", { description: error?.message })
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
        toast.error("Could not approve selected items", { description: error?.message })
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
        toast.success(`Rejected ${selectedRejectableItems.length} item${selectedRejectableItems.length === 1 ? "" : "s"}`)
      } catch (error: any) {
        toast.error("Could not reject selected items", { description: error?.message })
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
    toast.success(`Cost code applied to ${selectedAssignableItems.length} selected item${selectedAssignableItems.length === 1 ? "" : "s"}`)
  }

  function createInvoiceFromSelected() {
    if (selectedInvoiceItems.length === 0) return
    startTransition(async () => {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const costIds = selectedInvoiceItems.map((item) => item.recordId)
        const result = await generateInvoiceFromCostsAction({
          projectId,
          dateRange: { from: "1970-01-01", to: today },
          billableCostIds: costIds,
          groupBy: "cost_code",
          includeAllowanceVariances: false,
          dryRun: true,
        })
        setInvoicePreview(result)
        setInvoicePreviewCostIds(costIds)
      } catch (error: any) {
        toast.error("Could not preview invoice", { description: error?.message })
      }
    })
  }

  function confirmInvoiceFromPreview() {
    if (!invoicePreviewCostIds.length) return
    startTransition(async () => {
      try {
        const today = new Date().toISOString().slice(0, 10)
        const result = await generateInvoiceFromCostsAction({
          projectId,
          dateRange: { from: "1970-01-01", to: today },
          billableCostIds: invoicePreviewCostIds,
          groupBy: "cost_code",
          includeAllowanceVariances: false,
          dryRun: false,
          idempotencyKey: crypto.randomUUID(),
        })
        setCompletedIds((current) => {
          const next = new Set(current)
          for (const costId of invoicePreviewCostIds) next.add(`billable_cost:${costId}`)
          return next
        })
        setInvoicePreview(null)
        setInvoicePreviewCostIds([])
        toast.success("Invoice created from ready costs")
        router.push(`/projects/${projectId}/financials/receivables${result.invoiceId ? `?invoice=${result.invoiceId}` : ""}`)
      } catch (error: any) {
        toast.error("Could not create invoice", { description: error?.message })
      }
    })
  }

  return (
    <div className="w-full">
      <InboxWarnings errors={loadErrors} />
      <InboxSummaryStrip summary={summary} />
      <BulkActionBar
        selectedCount={selectedItems.length}
        readyCount={selectedReadyItems.length}
        rejectableCount={selectedRejectableItems.length}
        assignableCount={selectedAssignableItems.length}
        invoiceCount={selectedInvoiceItems.length}
        invoiceTotalCents={selectedInvoiceItems.reduce((sum, item) => sum + item.amountCents, 0)}
        costCodes={costCodes}
        bulkCostCodeId={bulkCostCodeId}
        isPending={isPending}
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
          <InboxTabTrigger value="awaiting-client-approval" label="Client Approval" count={tabCounts["awaiting-client-approval"]} />
          <InboxTabTrigger value="ready-to-invoice" label="Ready to Invoice" count={tabCounts["ready-to-invoice"]} />
        </TabsList>
      </Tabs>

      <QueueTable
        items={visibleItems}
        costCodes={costCodes}
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
        onOpenDetail={setDetailItem}
      />
      <ReviewQueueDetailSheet
        item={detailItem}
        costCodes={costCodes}
        selectedCostCodeId={selectedCostCodeId}
        isReady={isReady}
        isPending={isPending}
        onOpenChange={(open) => {
          if (!open) setDetailItem(null)
        }}
        onCostCodeChange={(item, value) =>
          setChosenCostCodes((current) => ({ ...current, [item.id]: value }))
        }
        onApprove={approve}
        onReject={reject}
        onSendClientApproval={sendClientApproval}
      />
      <InvoicePreviewDialog
        open={!!invoicePreview}
        preview={invoicePreview}
        isPending={isPending}
        onOpenChange={(open) => {
          if (!open) {
            setInvoicePreview(null)
            setInvoicePreviewCostIds([])
          }
        }}
        onConfirm={confirmInvoiceFromPreview}
      />
    </div>
  )
}

function InvoicePreviewDialog({
  open,
  preview,
  isPending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  preview: any | null
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const lines = preview?.invoicePreview?.lines ?? []
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
              {lines.map((line: any, index: number) => (
                <TableRow key={`${line.description}-${index}`}>
                  <TableCell>
                    <div className="font-medium">{line.description}</div>
                    <div className="text-xs text-muted-foreground">{line.billable_cost_ids?.length ?? 0} cost(s)</div>
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
          <span className="font-semibold">{formatCurrency(preview?.totalBillableCents ?? 0)}</span>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={isPending || lines.length === 0} onClick={onConfirm}>
            Create draft invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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

function InboxWarnings({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6 lg:px-8">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">Some financial data could not load.</p>
          <p className="mt-1 text-amber-800">{errors.join(" · ")}</p>
        </div>
      </div>
    </div>
  )
}

function InboxSummaryStrip({
  summary,
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
  }
}) {
  return (
    <div className="grid gap-px border-b bg-border sm:grid-cols-2 lg:grid-cols-4">
      <SummaryTile label="Needs review" value={String(summary.needsReviewCount)} />
      <SummaryTile label="Blocked" value={String(summary.blockedCount)} detail={formatBlockerDetail(summary)} tone={summary.blockedCount > 0 ? "warning" : "default"} />
      <SummaryTile label="Client approval" value={String(summary.awaitingClientApprovalCount)} />
      <SummaryTile label="Ready to invoice" value={formatCurrency(summary.readyToInvoiceCents)} detail={`${summary.readyToInvoiceCount} cost${summary.readyToInvoiceCount === 1 ? "" : "s"}`} tone={summary.readyToInvoiceCents > 0 ? "success" : "default"} />
    </div>
  )
}

function SummaryTile({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string
  value: string
  detail?: string
  tone?: "default" | "warning" | "success"
}) {
  return (
    <div className="bg-background px-4 py-4 sm:px-6">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p
        className={cn(
          "mt-1 text-2xl font-semibold tabular-nums",
          tone === "warning" && "text-amber-700",
          tone === "success" && "text-emerald-700",
        )}
      >
        {value}
      </p>
      {detail ? <p className="mt-1 text-xs text-muted-foreground">{detail}</p> : null}
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
  costCodes,
  bulkCostCodeId,
  isPending,
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
  costCodes: CostCodeOption[]
  bulkCostCodeId: string
  isPending: boolean
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
        {invoiceCount > 0 ? <span className="ml-2 text-muted-foreground">{formatCurrency(invoiceTotalCents)} ready</span> : null}
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
            <Button variant="outline" size="sm" disabled={isPending || bulkCostCodeId === NO_COST_CODE} onClick={onApplyBulkCostCode}>
              Apply code
            </Button>
          </>
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

function QueueTable({
  items,
  costCodes,
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
  onOpenDetail,
}: {
  items: QueueItem[]
  costCodes: CostCodeOption[]
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
  onOpenDetail: (item: QueueItem) => void
}) {
  const allSelected = items.length > 0 && items.every((item) => selectedIds.has(item.id))
  const partiallySelected = !allSelected && items.some((item) => selectedIds.has(item.id))

  return (
    <div className="w-full overflow-x-auto">
      <Table className="min-w-[860px] border border-border">
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
            <TableHead className="border-r">Source</TableHead>
            <TableHead className="w-[340px] border-r">Cost code</TableHead>
            <TableHead className="w-[140px] border-r text-right">Date</TableHead>
            <TableHead className="w-[150px] border-r text-right">Amount</TableHead>
            <TableHead className="w-28 text-center" colSpan={2}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const ready = isReady(item)
            return (
              <TableRow
                key={item.id}
                data-state={selectedIds.has(item.id) ? "selected" : undefined}
                className="h-14 cursor-pointer border-b"
                onClick={() => onOpenDetail(item)}
              >
                <TableCell className="border-r p-0 text-center align-middle" onClick={(event) => event.stopPropagation()}>
                  <div className="flex h-14 items-center justify-center">
                  <Checkbox
                    checked={selectedIds.has(item.id)}
                    onCheckedChange={(checked) => onToggleSelected(item.id, checked === true)}
                    aria-label={`Select ${item.source}`}
                  />
                  </div>
                </TableCell>
                <TableCell className="border-r font-medium">
                  {item.source}
                </TableCell>
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
                    <span className="flex h-14 items-center px-3 text-sm text-muted-foreground">{item.initialCostCodeLabel}</span>
                  )}
                </TableCell>
                <TableCell className="border-r text-right tabular-nums text-muted-foreground">{formatDate(item.date)}</TableCell>
                <TableCell className="border-r text-right font-medium tabular-nums">{formatCurrency(item.amountCents)}</TableCell>
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
                      title={ready ? "Approve" : disabledReason(item, selectedCostCodeId(item))}
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
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem asChild>
                          <Link href={item.href}>
                            <ExternalLink className="h-4 w-4" />
                            Open source
                          </Link>
                        </DropdownMenuItem>
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
          {items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                No items in this queue.
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}

function ReviewQueueDetailSheet({
  item,
  costCodes,
  selectedCostCodeId,
  isReady,
  isPending,
  onOpenChange,
  onCostCodeChange,
  onApprove,
  onReject,
  onSendClientApproval,
}: {
  item: QueueItem | null
  costCodes: CostCodeOption[]
  selectedCostCodeId: (item: QueueItem) => string
  isReady: (item: QueueItem) => boolean
  isPending: boolean
  onOpenChange: (open: boolean) => void
  onCostCodeChange: (item: QueueItem, value: string) => void
  onApprove: (item: QueueItem) => void
  onReject: (item: QueueItem) => void
  onSendClientApproval: (item: QueueItem) => void
}) {
  const ready = item ? isReady(item) : false

  return (
    <Sheet open={Boolean(item)} onOpenChange={onOpenChange}>
      {item ? (
        <SheetContent side="right" mobileFullscreen className="w-full p-0 sm:max-w-xl">
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <SheetTitle className="truncate text-lg">{item.source}</SheetTitle>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
              </div>
              <TypeBadge item={item} />
            </div>
          </SheetHeader>

          <div className="space-y-6 px-6 py-5">
            <div className="grid grid-cols-2 gap-3">
              <DetailBlock label="Date" value={formatDate(item.date)} />
              <DetailBlock label="Amount" value={formatCurrency(item.amountCents)} alignRight />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium uppercase text-muted-foreground">Cost code</p>
              {item.canChooseCostCode ? (
                <Select value={selectedCostCodeId(item)} onValueChange={(value) => onCostCodeChange(item, value)}>
                  <SelectTrigger className="h-11">
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
                <p className="text-sm">{item.initialCostCodeLabel}</p>
              )}
              {disabledReason(item, selectedCostCodeId(item)) ? (
                <p className="text-xs text-muted-foreground">{disabledReason(item, selectedCostCodeId(item))}</p>
              ) : null}
            </div>

            <div className="rounded-md border">
              <DetailRow label="Queue state" value={item.tabState.replace("-", " ")} />
              <DetailRow label="Record type" value={item.typeLabel} />
              <DetailRow label="Source record" value={item.recordId.slice(0, 8)} />
            </div>

            <div className="flex flex-wrap gap-2 border-t pt-5">
              <Button asChild variant="outline">
                <Link href={item.href}>
                  <ExternalLink className="h-4 w-4" />
                  Open source
                </Link>
              </Button>
              <Button
                disabled={isPending || !ready}
                className={cn(ready ? "bg-emerald-600 hover:bg-emerald-700" : "")}
                onClick={() => onApprove(item)}
              >
                <Check className="h-4 w-4" />
                Approve
              </Button>
              {item.kind === "time" && item.sourceRecord.status === "pm_approved" ? (
                <Button variant="outline" disabled={isPending} onClick={() => onSendClientApproval(item)}>
                  <Timer className="h-4 w-4" />
                  Send approval
                </Button>
              ) : null}
              {item.kind === "time" || item.kind === "expense" ? (
                <Button variant="ghost" disabled={isPending} onClick={() => onReject(item)}>
                  <X className="h-4 w-4" />
                  Reject
                </Button>
              ) : null}
            </div>
          </div>
        </SheetContent>
      ) : null}
    </Sheet>
  )
}

function DetailBlock({ label, value, alignRight = false }: { label: string; value: string; alignRight?: boolean }) {
  return (
    <div className={cn("rounded-md border p-3", alignRight && "text-right")}>
      <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b px-3 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium capitalize">{value}</span>
    </div>
  )
}

function TypeBadge({ item }: { item: QueueItem }) {
  const icon =
    item.kind === "time" ? <Timer className="h-3.5 w-3.5" /> :
    item.kind === "expense" ? <ReceiptText className="h-3.5 w-3.5" /> :
    item.kind === "vendor_bill" ? <CreditCard className="h-3.5 w-3.5" /> :
    <FileText className="h-3.5 w-3.5" />

  return (
    <Badge variant="outline" className="gap-1.5">
      {icon}
      {item.typeLabel}
    </Badge>
  )
}

function disabledReason(item: QueueItem, selectedCostCodeId: string) {
  if (item.tabState === "ready-to-invoice") return "Ready to invoice"
  if (item.tabState === "billed") return "Billed"
  if (item.kind === "time" && item.sourceRecord.status !== "submitted") return "Waiting on client approval"
  if (item.kind === "expense" && item.sourceRecord.status !== "submitted") return "Submit expense before approving"
  if (item.kind === "vendor_bill" && item.sourceRecord.status !== "pending") return "Bill is not pending"
  if (selectedCostCodeId === NO_COST_CODE) return "Choose a cost code"
  if (item.needsRate) return "Set a rate from the time entry"
  if (item.needsReceipt) return "Add a receipt before approving"
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
  return String(sourceType ?? "Cost").replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

function stateRank(state: QueueItem["tabState"]) {
  if (state === "blocked") return 0
  if (state === "needs-review") return 1
  if (state === "awaiting-client-approval") return 2
  if (state === "ready-to-invoice") return 3
  return 4
}

function formatBlockerDetail(summary: { missingCostCodeCount: number; missingReceiptCount: number; missingRateCount: number }) {
  const parts = [
    summary.missingCostCodeCount > 0 ? `${summary.missingCostCodeCount} code` : null,
    summary.missingReceiptCount > 0 ? `${summary.missingReceiptCount} receipt` : null,
    summary.missingRateCount > 0 ? `${summary.missingRateCount} rate` : null,
  ].filter(Boolean)
  return parts.length > 0 ? `Missing ${parts.join(", ")}` : "No blockers"
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
}

function formatDate(value?: string | null) {
  if (!value) return "No date"
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
