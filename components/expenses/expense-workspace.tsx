"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { format } from "date-fns"
import { ArrowLeft, CalendarDays, CheckCircle2, ExternalLink, Layers, Plus, Trash2, XCircle } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { AttachedFile } from "@/components/files"
import { PayableDocumentPane } from "@/components/payables/payable-document-pane"
import { WorkspaceShell } from "@/components/financials/workspace/workspace-shell"
import { WorkspaceListPanel, type WorkspaceQueue } from "@/components/financials/workspace/workspace-list-panel"
import { formatMoneyFromCents, qboBadge } from "@/components/financials/workspace/workspace-helpers"
import {
  approveProjectExpenseFormAction,
  getExpenseAccountingContextAction,
  listExpenseProjectsAction,
  rejectProjectExpenseFormAction,
  syncProjectExpenseToQBOAction,
  updateProjectExpenseAccountingAction,
  updateProjectExpenseDetailsAction,
  updateProjectExpenseLinesAction,
  updateProjectExpenseReceiptAction,
} from "@/app/(app)/projects/[id]/expenses/actions"
import { getFileAction, getFileDownloadUrlAction } from "@/app/(app)/documents/actions"
import {
  AUTO_QBO_VENDOR,
  accountLabel,
  formatCurrency,
  needsQboReview,
  qboDeepLink,
  readyForQboSync,
  isExpenseCredit,
  signedExpenseAmountCents,
  statusLabels,
  statusStyles,
  vendorOf,
  type ProjectExpense,
} from "./expense-shared"

type ExpenseAccountingContext = Awaited<ReturnType<typeof getExpenseAccountingContextAction>>

type QueueKey = "all" | "needs_review" | "ready" | "synced"

type ProjectOption = { id: string; name: string }

type SplitLine = {
  id: string
  projectId: string
  costCodeId: string
  budgetLineId: string
  description: string
  amountDollars: string
  qboExpenseAccountId: string
}

function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

const PAYMENT_METHODS: { value: string; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "credit_card", label: "Credit card" },
  { value: "company_card", label: "Company card" },
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH" },
  { value: "reimbursable_personal", label: "Personal (reimbursable)" },
  { value: "other", label: "Other" },
]

interface ExpenseWorkspaceProps {
  projectId: string
  expenses: ProjectExpense[]
  selectedExpenseId: string | null
  onSelect: (expenseId: string | null) => void
  accountingContext: ExpenseAccountingContext | null
  costCodesEnabled: boolean
  onChanged: () => void
}

function findAccount(
  accounts: { id: string; name: string; fullyQualifiedName?: string }[] | undefined,
  id: string | null | undefined,
) {
  if (!id) return null
  return (accounts ?? []).find((account) => account.id === id) ?? null
}

function parseDate(value?: string) {
  if (!value) return undefined
  const date = new Date(`${value}T00:00:00`)
  return isNaN(date.getTime()) ? undefined : date
}

export function ExpenseWorkspace({
  projectId,
  expenses,
  selectedExpenseId,
  onSelect,
  accountingContext,
  costCodesEnabled,
  onChanged,
}: ExpenseWorkspaceProps) {
  const [isPending, startTransition] = useTransition()

  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<QueueKey>("all")

  const [expenseDate, setExpenseDate] = useState("")
  const [paymentMethod, setPaymentMethod] = useState("")
  const [memo, setMemo] = useState("")
  const [qboPaymentAccountId, setQboPaymentAccountId] = useState("")
  const [qboVendorId, setQboVendorId] = useState<string>(AUTO_QBO_VENDOR)
  const [splitLines, setSplitLines] = useState<SplitLine[]>([])
  const [projects, setProjects] = useState<ProjectOption[]>([])

  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const receiptFileIdRef = useRef<string | null>(null)

  const qboConnected = Boolean(accountingContext?.qboConnected)
  const expenseAccounts = accountingContext?.expenseAccounts ?? []
  const paymentAccounts = accountingContext?.paymentAccounts ?? []
  const vendors = accountingContext?.vendors ?? []
  const costCodes = (accountingContext?.costCodes ?? []) as { id: string; code?: string | null; name?: string | null }[]
  const budgetLines = (accountingContext?.budgetLines ?? []) as { id: string; description?: string | null; amount_cents?: number | null }[]

  const selectedExpense = useMemo(
    () => expenses.find((expense) => expense.id === selectedExpenseId) ?? null,
    [expenses, selectedExpenseId],
  )

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim()
    return expenses.filter((expense) => {
      const matchesQueue =
        queueFilter === "all" ||
        (queueFilter === "needs_review" && needsQboReview(expense)) ||
        (queueFilter === "ready" && readyForQboSync(expense)) ||
        (queueFilter === "synced" && expense.qbo_sync_status === "synced")
      if (!matchesQueue) return false
      if (!term) return true
      return [
        vendorOf(expense),
        expense.description ?? "",
        costCodesEnabled ? expense.cost_code?.code ?? "" : "",
        expense.qbo_expense_account_name ?? "",
        expense.qbo_vendor_name ?? "",
        expense.expense_date ?? "",
      ].some((value) => String(value).toLowerCase().includes(term))
    })
  }, [expenses, search, queueFilter, costCodesEnabled])

  const queues: WorkspaceQueue<QueueKey>[] = useMemo(
    () => [
      { key: "all", label: "All", count: expenses.length },
      { key: "needs_review", label: "Review", count: expenses.filter(needsQboReview).length },
      { key: "ready", label: "Ready", count: expenses.filter(readyForQboSync).length },
      { key: "synced", label: "Synced", count: expenses.filter((e) => e.qbo_sync_status === "synced").length },
    ],
    [expenses],
  )

  // Load the projects an expense split can allocate to (cross-project parity with payables).
  useEffect(() => {
    let cancelled = false
    void listExpenseProjectsAction()
      .then((rows) => {
        if (!cancelled) setProjects(rows)
      })
      .catch(() => {
        if (!cancelled) setProjects([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Initialise the editable form whenever the selected expense changes.
  useEffect(() => {
    if (!selectedExpense) return
    setExpenseDate(selectedExpense.expense_date ?? "")
    setPaymentMethod(selectedExpense.payment_method ?? "")
    setMemo(selectedExpense.description ?? "")
    setQboPaymentAccountId(
      selectedExpense.qbo_payment_account_id ??
        (selectedExpense.payment_method === "company_card"
          ? accountingContext?.defaults?.creditCardAccountId
          : accountingContext?.defaults?.paymentAccountId) ??
        "",
    )
    setQboVendorId(selectedExpense.qbo_vendor_id ?? AUTO_QBO_VENDOR)

    const defaultAccountId = selectedExpense.qbo_expense_account_id ?? accountingContext?.defaults?.expenseAccountId ?? ""
    const total = (selectedExpense.amount_cents ?? 0) + (selectedExpense.tax_cents ?? 0)
    const existing = selectedExpense.lines ?? []
    setSplitLines(
      existing.length > 0
        ? existing.map((line) => ({
            id: line.id ?? crypto.randomUUID(),
            projectId: line.project_id ?? projectId,
            costCodeId: line.cost_code_id ?? "",
            budgetLineId: line.budget_line_id ?? "",
            description: line.description ?? selectedExpense.description ?? "",
            amountDollars: ((line.amount_cents ?? 0) / 100).toFixed(2),
            qboExpenseAccountId: line.qbo_expense_account_id ?? defaultAccountId,
          }))
        : [
            {
              id: crypto.randomUUID(),
              projectId,
              costCodeId: selectedExpense.cost_code_id ?? "",
              budgetLineId: selectedExpense.budget_line_id ?? "",
              description: selectedExpense.description ?? "",
              amountDollars: (total / 100).toFixed(2),
              qboExpenseAccountId: defaultAccountId,
            },
          ],
    )
  }, [selectedExpense, accountingContext, projectId])

  // Load the receipt for the selected expense and present it as a single attachment.
  const loadReceipt = useMemo(
    () =>
      async (fileId: string | null) => {
        receiptFileIdRef.current = fileId
        if (!fileId) {
          setAttachments([])
          return
        }
        const file = await getFileAction(fileId)
        if (!file) {
          setAttachments([])
          return
        }
        const downloadUrl = await getFileDownloadUrlAction(file.id).catch(() => `/api/files/${file.id}/raw`)
        setAttachments([
          {
            id: file.id,
            linkId: file.id,
            file_name: file.file_name,
            mime_type: file.mime_type ?? undefined,
            size_bytes: file.size_bytes ?? undefined,
            download_url: downloadUrl,
            thumbnail_url: file.mime_type?.startsWith("image/") ? downloadUrl : undefined,
            created_at: file.created_at ?? new Date().toISOString(),
          },
        ])
      },
    [],
  )

  useEffect(() => {
    if (!selectedExpense) {
      setAttachments([])
      receiptFileIdRef.current = null
      return
    }
    let cancelled = false
    setAttachmentsLoading(true)
    loadReceipt(selectedExpense.receipt_file_id ?? null)
      .catch((error) => console.error("Failed to load expense receipt", error))
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedExpense, loadReceipt])

  if (!selectedExpense) return <WorkspaceShell open={false} onClose={() => onSelect(null)} listPanel={null} documentPane={null}>{null}</WorkspaceShell>

  const totalCents = (selectedExpense.amount_cents ?? 0) + (selectedExpense.tax_cents ?? 0)
  const displayTotalCents = signedExpenseAmountCents(selectedExpense)
  const selectedIsCredit = isExpenseCredit(selectedExpense)
  const isSubmitted = selectedExpense.status === "submitted"
  const canSync = selectedExpense.status === "approved" && selectedExpense.qbo_sync_status !== "synced"

  const getExpenseAccountName = (id?: string) => findAccount(expenseAccounts, id)?.name
  const distinctSplitProjects = Array.from(new Set(splitLines.map((line) => line.projectId).filter(Boolean)))
  const isSplitAcrossProjects = distinctSplitProjects.length > 1
  const splitTotalCents = splitLines.reduce((sum, line) => sum + (dollarsToCents(line.amountDollars) ?? 0), 0)
  const splitsBalanced = splitTotalCents === totalCents

  const handleAttach = async (files: File[]) => {
    const file = files[0]
    if (!file) return
    const formData = new FormData()
    formData.append("receipt", file)
    const next = await updateProjectExpenseReceiptAction(projectId, selectedExpense.id, formData)
    const updated = (next as ProjectExpense[]).find((expense) => expense.id === selectedExpense.id)
    await loadReceipt(updated?.receipt_file_id ?? null)
    onChanged()
  }

  const handleDetach = async (linkId: string) => {
    // The replace flow calls onAttach (which already swaps the receipt) then onDetach with the
    // OLD file id; ignore that stale id so we only clear when deleting the current receipt.
    if (linkId !== receiptFileIdRef.current) return
    await updateProjectExpenseReceiptAction(projectId, selectedExpense.id, new FormData())
    receiptFileIdRef.current = null
    setAttachments([])
    onChanged()
  }

  const save = () => {
    const isSplit = splitLines.length > 1
    const firstLine = splitLines[0]
    const firstLineAccount = firstLine?.qboExpenseAccountId ? findAccount(expenseAccounts, firstLine.qboExpenseAccountId) : null
    const paymentAccount = findAccount(paymentAccounts, qboPaymentAccountId)
    const qboVendor = qboVendorId === AUTO_QBO_VENDOR ? null : findAccount(vendors, qboVendorId)

    if (isSplit) {
      const invalid = splitLines.some(
        (line) => !line.projectId || (costCodesEnabled && !line.costCodeId) || (dollarsToCents(line.amountDollars) ?? -1) < 0,
      )
      if (invalid) {
        toast.error(costCodesEnabled ? "Each split needs a project, cost code, and amount." : "Each split needs a project and amount.")
        return
      }
      if (!splitsBalanced) {
        toast.error(`Splits (${formatMoneyFromCents(splitTotalCents)}) must equal the expense total (${formatMoneyFromCents(totalCents)})`)
        return
      }
    }

    const lines = isSplit
      ? splitLines.map((line) => ({
          project_id: line.projectId || projectId,
          cost_code_id: costCodesEnabled ? line.costCodeId || null : null,
          budget_line_id: costCodesEnabled ? null : line.budgetLineId || null,
          description: line.description.trim() || memo || null,
          amount_cents: dollarsToCents(line.amountDollars) ?? 0,
          qbo_expense_account_id: line.qboExpenseAccountId || null,
          qbo_expense_account_name: getExpenseAccountName(line.qboExpenseAccountId) ?? null,
        }))
      : []

    startTransition(async () => {
      try {
        await updateProjectExpenseDetailsAction(projectId, selectedExpense.id, {
          description: memo,
          expenseDate: expenseDate || undefined,
          paymentMethod: paymentMethod || null,
          // When split, per-line coding drives job costing; keep the single-line code only otherwise.
          ...(costCodesEnabled && !isSplit ? { costCodeId: firstLine?.costCodeId || null } : {}),
          ...(!costCodesEnabled && !isSplit ? { budgetLineId: firstLine?.budgetLineId || null } : {}),
        })
        await updateProjectExpenseAccountingAction(projectId, selectedExpense.id, {
          qboTransactionType: "purchase",
          qboExpenseAccountId: firstLineAccount?.id ?? null,
          qboExpenseAccountName: firstLineAccount ? accountLabel(firstLineAccount) : null,
          qboPaymentAccountId: paymentAccount?.id ?? null,
          qboPaymentAccountName: paymentAccount ? accountLabel(paymentAccount) : null,
          qboApAccountId: null,
          qboApAccountName: null,
          qboVendorId: qboVendor?.id ?? null,
          qboVendorName: qboVendor ? accountLabel(qboVendor) : null,
        })
        await updateProjectExpenseLinesAction(projectId, selectedExpense.id, lines)
        toast.success("Expense saved")
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const addSplitLine = () =>
    setSplitLines((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        projectId,
        costCodeId: "",
        budgetLineId: prev[0]?.budgetLineId ?? "",
        description: memo,
        amountDollars: "0.00",
        qboExpenseAccountId: prev[0]?.qboExpenseAccountId ?? accountingContext?.defaults?.expenseAccountId ?? "",
      },
    ])

  const runAction = (fn: () => Promise<unknown>, successMessage: string) => {
    startTransition(async () => {
      try {
        await fn()
        toast.success(successMessage)
        onChanged()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  const listPanel = (
    <WorkspaceListPanel<ProjectExpense, QueueKey>
      title="Expenses"
      onBack={() => onSelect(null)}
      search={search}
      onSearchChange={setSearch}
      searchPlaceholder="Search vendor, memo..."
      queues={queues}
      activeQueue={queueFilter}
      onQueueChange={setQueueFilter}
      items={filtered}
      getKey={(expense) => expense.id}
      isActive={(expense) => expense.id === selectedExpense.id}
      onSelect={(expense) => onSelect(expense.id)}
      emptyLabel="No expenses match."
      renderRow={(expense) => {
        const amount = signedExpenseAmountCents(expense)
        return (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-semibold">{vendorOf(expense)}</span>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{formatMoneyFromCents(amount)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">
                {expense.expense_date ? format(new Date(`${expense.expense_date}T00:00:00`), "MMM d") : "No date"}
              </span>
              <span className="shrink-0">{statusLabels[expense.status] ?? expense.status}</span>
            </div>
          </>
        )
      }}
    />
  )

  const documentPane = (
    <PayableDocumentPane
      attachments={attachments}
      loading={attachmentsLoading}
      onAttach={handleAttach}
      onDetach={handleDetach}
      projectId={projectId}
    />
  )

  return (
    <WorkspaceShell open onClose={() => onSelect(null)} listPanel={listPanel} documentPane={documentPane}>
      {/* Header */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" onClick={() => onSelect(null)} title="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold leading-tight">{vendorOf(selectedExpense)}</h2>
            <p className="truncate text-xs text-muted-foreground">{formatCurrency(displayTotalCents)} {selectedIsCredit ? "credit" : "expense"}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-tight ${statusStyles[selectedExpense.status] ?? ""}`}>
            {statusLabels[selectedExpense.status] ?? selectedExpense.status}
          </Badge>
          {qboConnected ? qboBadge(selectedExpense.qbo_sync_status, selectedExpense.qbo_sync_error) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-4 py-6 sm:px-6">
        {/* Amount hero */}
        <div className="space-y-4 rounded-xl border bg-muted/10 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total amount</p>
              <p className="mt-1 text-3xl font-bold tabular-nums tracking-tight">{formatMoneyFromCents(displayTotalCents)}</p>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-right">
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Subtotal</span>
              <span className="text-sm font-semibold tabular-nums">{formatMoneyFromCents(selectedExpense.amount_cents ?? 0)}</span>
              <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Tax</span>
              <span className="text-sm font-semibold tabular-nums">{formatMoneyFromCents(selectedExpense.tax_cents ?? 0)}</span>
            </div>
          </div>

          {qboConnected ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Sync status:</span>
                {qboBadge(selectedExpense.qbo_sync_status, selectedExpense.qbo_sync_error)}
                {qboDeepLink(selectedExpense) ? (
                  <a href={qboDeepLink(selectedExpense)!} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    Open in QuickBooks <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
              {selectedExpense.qbo_sync_status === "error" && selectedExpense.qbo_sync_error ? (
                <span className="max-w-sm truncate text-[11px] font-medium text-destructive" title={selectedExpense.qbo_sync_error}>
                  {selectedExpense.qbo_sync_error}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Vendor */}
        <div className="rounded-xl border bg-muted/5 p-4">
          <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Merchant</Label>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold">{vendorOf(selectedExpense)}</span>
          </div>
          {qboConnected ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {selectedExpense.qbo_vendor_id
                ? `QuickBooks vendor: ${selectedExpense.qbo_vendor_name ?? "Linked vendor"}`
                : "No QuickBooks vendor linked. Choose one below or let Arc match by merchant name."}
            </p>
          ) : null}
        </div>

        {/* Expense details */}
        <section className="space-y-4 rounded-xl border bg-muted/5 p-4">
          <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Expense details</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className={cn("h-10 w-full justify-start text-left text-sm font-semibold", !expenseDate && "text-muted-foreground")}
                  >
                    <CalendarDays className="mr-2 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">{expenseDate && parseDate(expenseDate) ? format(parseDate(expenseDate)!, "PPP") : "Pick a date"}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={parseDate(expenseDate)}
                    onSelect={(date) => setExpenseDate(date ? format(date, "yyyy-MM-dd") : "")}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Payment method</Label>
              <Select value={paymentMethod || undefined} onValueChange={setPaymentMethod}>
                <SelectTrigger className="h-10 w-full">
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.map((method) => (
                    <SelectItem key={method.value} value={method.value}>
                      {method.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Memo</Label>
            <Input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="What was this for?" className="h-10 text-sm" />
          </div>
        </section>

        {/* QuickBooks coding */}
        {qboConnected ? (
          <section className="space-y-4 rounded-xl border bg-muted/5 p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">QuickBooks coding</h3>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">QBO vendor</Label>
              <Select value={qboVendorId} onValueChange={setQboVendorId}>
                <SelectTrigger className="h-10 w-full text-sm">
                  <SelectValue placeholder="Match/create automatically" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_QBO_VENDOR}>Match/create automatically</SelectItem>
                  {vendors.map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.id}>
                      {accountLabel(vendor)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Paid from</Label>
              <Select value={qboPaymentAccountId || undefined} onValueChange={setQboPaymentAccountId}>
                <SelectTrigger className="h-10 w-full text-sm">
                  <SelectValue placeholder="Bank or credit card" />
                </SelectTrigger>
                <SelectContent>
                  {paymentAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">The QBO expense category is set per line item below.</p>
            </div>
          </section>
        ) : null}

        {/* Line items / cost splits */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Line items</h3>
            <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={addSplitLine}>
              <Plus className="mr-1 h-3 w-3" />
              Add line item
            </Button>
          </div>

          {isSplitAcrossProjects ? (
            <div className="flex items-center gap-2 rounded-md bg-indigo-50 px-3 py-1.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/30 dark:text-indigo-300">
              <Layers className="h-3.5 w-3.5" />
              Split across {distinctSplitProjects.length} projects — one receipt, one QuickBooks transaction.
            </div>
          ) : null}

          <div className="space-y-3">
            {splitLines.map((line) => (
              <div key={line.id} className="relative space-y-3 rounded-xl border bg-background p-4 shadow-sm">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Project</Label>
                    <Select
                      value={line.projectId}
                      onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, projectId: value } : item)))}
                    >
                      <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select project" /></SelectTrigger>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id} className="text-xs">{project.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Amount</Label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-xs text-muted-foreground">$</span>
                        <Input
                          value={line.amountDollars}
                          inputMode="decimal"
                          className="h-9 pl-7 text-xs font-semibold tabular-nums"
                          onChange={(event) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, amountDollars: event.target.value } : item)))}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={splitLines.length === 1}
                        onClick={() => setSplitLines((prev) => prev.filter((item) => item.id !== line.id))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {costCodesEnabled ? (
                    <div>
                      <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Cost code</Label>
                      <Select
                        value={line.costCodeId || "__none__"}
                        onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, costCodeId: value === "__none__" ? "" : value } : item)))}
                      >
                        <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select cost code" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs">No cost code</SelectItem>
                          {costCodes.map((code) => (
                            <SelectItem key={code.id} value={code.id} className="text-xs">
                              {code.code ? `${code.code} - ${code.name}` : code.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : budgetLines.length > 0 ? (
                    <div>
                      <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Budget line</Label>
                      <Select
                        value={line.budgetLineId || "__none__"}
                        onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, budgetLineId: value === "__none__" ? "" : value } : item)))}
                      >
                        <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select budget line" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__" className="text-xs">Unassigned</SelectItem>
                          {budgetLines.map((bl) => (
                            <SelectItem key={bl.id} value={bl.id} className="text-xs">
                              {bl.description?.trim() || "Untitled line"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : null}
                  <div className={cn(!costCodesEnabled && budgetLines.length === 0 && "sm:col-span-2")}>
                    <Label className="mb-1 block text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Description</Label>
                    <Input
                      value={line.description}
                      placeholder="Line description..."
                      className="h-9 text-xs"
                      onChange={(event) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, description: event.target.value } : item)))}
                    />
                  </div>
                </div>

                {qboConnected ? (
                  <div className="mt-3 border-t pt-3">
                    <Label className="mb-1 block text-[9px] font-bold uppercase tracking-widest text-muted-foreground">QBO category</Label>
                    <Select
                      value={line.qboExpenseAccountId || undefined}
                      onValueChange={(value) => setSplitLines((prev) => prev.map((item) => (item.id === line.id ? { ...item, qboExpenseAccountId: value } : item)))}
                    >
                      <SelectTrigger className="h-9 w-full text-xs"><SelectValue placeholder="Select category" /></SelectTrigger>
                      <SelectContent>
                        {expenseAccounts.map((account) => (
                          <SelectItem key={account.id} value={account.id} className="text-xs">{accountLabel(account)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          {splitLines.length > 1 ? (
            <div className={cn("flex items-center justify-between rounded-md px-3 py-2 text-xs font-medium", splitsBalanced ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-300")}>
              <span>Allocated {formatMoneyFromCents(splitTotalCents)} of {formatMoneyFromCents(totalCents)}</span>
              <span>{splitsBalanced ? "Balanced" : `${formatMoneyFromCents(totalCents - splitTotalCents)} unallocated`}</span>
            </div>
          ) : null}
        </section>

        {/* Workflow actions */}
        {isSubmitted ? (
          <div className="grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              className="h-11 border-emerald-600 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
              disabled={isPending}
              onClick={() => runAction(() => approveProjectExpenseFormAction(projectId, selectedExpense.id), "Expense approved")}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Approve
            </Button>
            <Button
              variant="outline"
              className="h-11 border-destructive/40 text-destructive hover:bg-destructive/10"
              disabled={isPending}
              onClick={() => runAction(() => rejectProjectExpenseFormAction(projectId, selectedExpense.id), "Expense rejected")}
            >
              <XCircle className="mr-2 h-4 w-4" />
              Reject
            </Button>
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 border-t bg-muted/10 px-4 py-3 sm:px-6">
        <Button
          variant="ghost"
          disabled={isPending || !canSync || !qboConnected}
          onClick={() => runAction(() => syncProjectExpenseToQBOAction(projectId, selectedExpense.id), "Expense synced to QuickBooks")}
        >
          <ExternalLink className="mr-2 h-4 w-4" />
          Sync to QuickBooks
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => onSelect(null)}>
            Close
          </Button>
          <Button disabled={isPending} onClick={save}>
            {isPending ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
    </WorkspaceShell>
  )
}
