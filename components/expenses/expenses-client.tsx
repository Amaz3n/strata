"use client"

import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Check, CheckCircle2, ChevronsUpDown, ExternalLink, Loader2, MoreHorizontal, Paperclip, Plus, Receipt, SlidersHorizontal, Sparkles, Upload } from "@/components/icons"

import {
  approveProjectExpenseFormAction,
  createMyExpenseAction,
  extractExpenseReceiptAction,
  getExpenseAccountingContextAction,
  listProjectExpensesAction,
  rejectProjectExpenseFormAction,
  syncProjectExpenseToQBOAction,
  updateProjectExpenseAccountingAction,
  type CreateMyExpenseInput,
  type ReceiptExtractionResult,
} from "@/app/(app)/projects/[id]/expenses/actions"
import { ExpenseForm } from "@/components/expenses/expense-form"
import { cn } from "@/lib/utils"

interface ProjectExpense {
  id: string
  expense_date: string
  vendor_name_text: string | null
  description: string | null
  status: string
  amount_cents: number | null
  tax_cents: number | null
  is_billable: boolean | null
  receipt_file_id: string | null
  payment_method: string | null
  qbo_id?: string | null
  qbo_sync_status?: "pending" | "synced" | "error" | "skipped" | "needs_review" | null
  qbo_sync_error?: string | null
  qbo_transaction_type?: "purchase" | "bill" | null
  qbo_expense_account_id?: string | null
  qbo_expense_account_name?: string | null
  qbo_payment_account_id?: string | null
  qbo_payment_account_name?: string | null
  qbo_ap_account_id?: string | null
  qbo_ap_account_name?: string | null
  qbo_vendor_id?: string | null
  qbo_vendor_name?: string | null
  vendor_company?: { name?: string | null } | null
  cost_code?: { code?: string | null; name?: string | null } | null
}

interface ExpensesClientProps {
  projectId: string
  initialExpenses: ProjectExpense[]
}

type ExpenseAccountingContext = Awaited<ReturnType<typeof getExpenseAccountingContextAction>>
type AccountingDraft = {
  qboTransactionType: "purchase" | "bill"
  qboExpenseAccountId: string
  qboPaymentAccountId: string
  qboApAccountId: string
  qboVendorId: string
}

type StatusKey = "submitted" | "approved" | "rejected" | "invoiced" | "draft" | string

const statusLabels: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
  invoiced: "Invoiced",
}

const statusStyles: Record<string, string> = {
  draft: "bg-muted text-muted-foreground border-muted",
  submitted: "bg-warning/20 text-warning border-warning/40",
  approved: "bg-success/20 text-success border-success/30",
  rejected: "bg-destructive/15 text-destructive border-destructive/30",
  invoiced: "bg-muted text-muted-foreground border-muted",
}

const qboStatusStyles: Record<string, string> = {
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  synced: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  error: "border-destructive/30 bg-destructive/10 text-destructive",
  needs_review: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  skipped: "border-muted bg-muted text-muted-foreground",
}

const qboStatusLabels: Record<string, string> = {
  pending: "QBO pending",
  synced: "QBO synced",
  error: "QBO error",
  needs_review: "Needs QBO info",
  skipped: "QBO skipped",
}

const AUTO_QBO_VENDOR = "__auto_qbo_vendor__"

function formatCurrency(cents: number | null | undefined) {
  return ((cents ?? 0) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—"
  try {
    return format(new Date(`${value}T00:00:00`), "MMM d, yyyy")
  } catch {
    return value
  }
}

function vendorOf(expense: ProjectExpense) {
  return expense.vendor_company?.name ?? expense.vendor_name_text ?? expense.description ?? "Expense"
}

function accountLabel(account: { name: string; fullyQualifiedName?: string }) {
  return account.fullyQualifiedName ?? account.name
}

function findAccount(
  accounts: { id: string; name: string; fullyQualifiedName?: string }[] | undefined,
  id: string,
) {
  return (accounts ?? []).find((account) => account.id === id) ?? null
}

function defaultAccountingDraft(expense: ProjectExpense, context: ExpenseAccountingContext | null): AccountingDraft {
  const type =
    expense.qbo_transaction_type ??
    (expense.payment_method === "reimbursable_personal" ? "bill" : "purchase")

  return {
    qboTransactionType: type,
    qboExpenseAccountId: expense.qbo_expense_account_id ?? context?.defaults?.expenseAccountId ?? "",
    qboPaymentAccountId:
      expense.qbo_payment_account_id ??
      (expense.payment_method === "company_card"
        ? context?.defaults?.creditCardAccountId
        : context?.defaults?.paymentAccountId) ??
      "",
    qboApAccountId: expense.qbo_ap_account_id ?? context?.defaults?.apAccountId ?? "",
    qboVendorId: expense.qbo_vendor_id ?? AUTO_QBO_VENDOR,
  }
}

function qboTransactionLabel(type?: "purchase" | "bill" | null) {
  if (type === "bill") return "Bill"
  return "Purchase"
}

function qboDeepLink(expense: ProjectExpense) {
  if (!expense.qbo_id) return null
  if (expense.qbo_transaction_type === "bill") {
    return `https://qbo.intuit.com/app/bill?txnId=${expense.qbo_id}`
  }
  return `https://qbo.intuit.com/app/expense?txnId=${expense.qbo_id}`
}

function AccountCombobox({
  expense,
  context,
  open,
  disabled,
  saving,
  onOpenChange,
  onSelect,
}: {
  expense: ProjectExpense
  context: ExpenseAccountingContext | null
  open: boolean
  disabled?: boolean
  saving?: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (accountId: string) => void
}) {
  const accounts = context?.expenseAccounts ?? []
  const selectedLabel = expense.qbo_expense_account_name ?? "Choose account"

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-auto min-h-9 w-full justify-between gap-2 px-2 py-1.5 text-left"
        >
          <span className="flex min-w-0 items-center gap-2">
            {saving ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <SlidersHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-foreground">{selectedLabel}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {qboTransactionLabel(expense.qbo_transaction_type)}
                {expense.qbo_vendor_name ? ` · ${expense.qbo_vendor_name}` : ""}
                {expense.qbo_payment_account_name
                  ? ` · ${expense.qbo_payment_account_name}`
                  : expense.qbo_ap_account_name
                    ? ` · ${expense.qbo_ap_account_name}`
                    : ""}
              </span>
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search accounts..." />
          <CommandList>
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup heading="Accounts">
              {accounts.map((account) => {
                const label = accountLabel(account)
                const selected = account.id === expense.qbo_expense_account_id
                return (
                  <CommandItem
                    key={account.id}
                    value={`${label} ${account.accountType ?? ""}`}
                    onSelect={() => onSelect(account.id)}
                  >
                    <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{label}</span>
                      {account.accountType ? (
                        <span className="block truncate text-xs text-muted-foreground">{account.accountType}</span>
                      ) : null}
                    </span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ExpenseQBOStatus({ expense, compact = false }: { expense: ProjectExpense; compact?: boolean }) {
  if (!expense.qbo_sync_status) return null
  const label = qboStatusLabels[expense.qbo_sync_status] ?? expense.qbo_sync_status
  return (
    <Badge
      variant="outline"
      title={expense.qbo_sync_error ?? expense.qbo_expense_account_name ?? undefined}
      className={`mt-1 w-fit border text-[10px] font-normal ${compact ? "ml-1 mt-0 px-1.5 py-0" : "px-1.5 py-0"} ${qboStatusStyles[expense.qbo_sync_status] ?? ""}`}
    >
      {label}
    </Badge>
  )
}

function isSupportedReceiptFile(file: File | null | undefined) {
  if (!file) return false
  const type = file.type.toLowerCase()
  const name = file.name.toLowerCase()
  return type.startsWith("image/") || type === "application/pdf" || /\.(pdf|jpe?g|png|webp|heic|heif)$/.test(name)
}

function hasExternalFileDrag(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files")
}

interface PendingReceipt {
  id: number
  file: File
}

export function ExpensesClient({ projectId, initialExpenses }: ExpensesClientProps) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<ProjectExpense[]>(initialExpenses)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [isPageDragging, setIsPageDragging] = useState(false)
  const [pendingReceipt, setPendingReceipt] = useState<PendingReceipt | null>(null)
  const [accountingContext, setAccountingContext] = useState<ExpenseAccountingContext | null>(null)
  const [accountingExpense, setAccountingExpense] = useState<ProjectExpense | null>(null)
  const [accountingDraft, setAccountingDraft] = useState<AccountingDraft | null>(null)
  const [accountingSaving, setAccountingSaving] = useState(false)
  const [openAccountExpenseId, setOpenAccountExpenseId] = useState<string | null>(null)
  const [savingAccountExpenseId, setSavingAccountExpenseId] = useState<string | null>(null)
  const dragDepthRef = useRef(0)
  const [isPending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim()
    return items.filter((expense) => {
      const matchesStatus = statusFilter === "all" || expense.status === statusFilter
      if (!matchesStatus) return false
      if (!term) return true
      return [
        vendorOf(expense),
        expense.description ?? "",
        expense.cost_code?.code ?? "",
        expense.cost_code?.name ?? "",
        expense.qbo_expense_account_name ?? "",
        expense.qbo_payment_account_name ?? "",
        expense.qbo_ap_account_name ?? "",
        expense.qbo_vendor_name ?? "",
        expense.expense_date ?? "",
      ]
        .some((value) => String(value).toLowerCase().includes(term))
    })
  }, [items, search, statusFilter])

  const refresh = useCallback(() => {
    startTransition(async () => {
      try {
        const next = await listProjectExpensesAction(projectId)
        setItems(next as ProjectExpense[])
      } catch (error) {
        console.error("Failed to refresh expenses", error)
      }
    })
  }, [projectId])

  useEffect(() => {
    let cancelled = false
    void getExpenseAccountingContextAction()
      .then((context) => {
        if (!cancelled) setAccountingContext(context)
      })
      .catch(() => {
        if (!cancelled) setAccountingContext(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleCreate(payload: CreateMyExpenseInput, receipt: File | null) {
    const formData = new FormData()
    formData.append("payload", JSON.stringify(payload))
    if (receipt) formData.append("receipt", receipt)

    return new Promise<void>((resolve, reject) => {
      startTransition(async () => {
        try {
          const next = await createMyExpenseAction(projectId, formData)
          setItems((next as ProjectExpense[]) ?? [])
          setSheetOpen(false)
          toast.success("Receipt submitted for review")
          resolve()
        } catch (error: any) {
          console.error(error)
          toast.error("Could not submit receipt", { description: error?.message ?? "Please try again." })
          reject(error)
        }
      })
    })
  }

  async function handleExtract(receipt: File): Promise<ReceiptExtractionResult> {
    const formData = new FormData()
    formData.append("receipt", receipt)
    return extractExpenseReceiptAction(projectId, formData)
  }

  function handlePageDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasExternalFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setIsPageDragging(true)
  }

  function handlePageDragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasExternalFileDrag(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
    setIsPageDragging(true)
  }

  function handlePageDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasExternalFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsPageDragging(false)
  }

  function handlePageDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasExternalFileDrag(event)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setIsPageDragging(false)

    const file = event.dataTransfer.files?.[0] ?? null
    if (!isSupportedReceiptFile(file)) {
      toast.error("Drop an image or PDF receipt")
      return
    }

    setPendingReceipt({ id: Date.now(), file })
    setSheetOpen(true)
  }

  function openBlankExpense() {
    setPendingReceipt(null)
    setSheetOpen(true)
  }

  function openAccounting(expense: ProjectExpense) {
    setAccountingExpense(expense)
    setAccountingDraft(defaultAccountingDraft(expense, accountingContext))
  }

  function closeAccounting(open: boolean) {
    if (open) return
    setAccountingExpense(null)
    setAccountingDraft(null)
    setAccountingSaving(false)
  }

  function approve(expenseId: string) {
    startTransition(async () => {
      try {
        await approveProjectExpenseFormAction(projectId, expenseId)
        toast.success("Expense approved")
        refresh()
      } catch (error: any) {
        toast.error("Could not approve", { description: error?.message })
      }
    })
  }

  function reject(expenseId: string) {
    startTransition(async () => {
      try {
        await rejectProjectExpenseFormAction(projectId, expenseId)
        toast.success("Expense rejected")
        refresh()
      } catch (error: any) {
        toast.error("Could not reject", { description: error?.message })
      }
    })
  }

  function syncExpense(expenseId: string) {
    startTransition(async () => {
      try {
        await syncProjectExpenseToQBOAction(projectId, expenseId)
        toast.success("Expense synced to QuickBooks")
        refresh()
      } catch (error: any) {
        toast.error("Could not sync to QuickBooks", { description: error?.message })
        refresh()
      }
    })
  }

  async function saveAccounting(syncAfterSave = false) {
    if (!accountingExpense || !accountingDraft) return
    const expenseAccount = findAccount(accountingContext?.expenseAccounts, accountingDraft.qboExpenseAccountId)
    const paymentAccount = findAccount(accountingContext?.paymentAccounts, accountingDraft.qboPaymentAccountId)
    const apAccount = findAccount(accountingContext?.apAccounts, accountingDraft.qboApAccountId)
    const qboVendor =
      accountingDraft.qboVendorId === AUTO_QBO_VENDOR
        ? null
        : findAccount(accountingContext?.vendors, accountingDraft.qboVendorId)

    if (!expenseAccount) {
      toast.error("Choose a QuickBooks account")
      return
    }
    if (accountingDraft.qboTransactionType === "purchase" && !paymentAccount) {
      toast.error("Choose the QuickBooks account this was paid from")
      return
    }

    setAccountingSaving(true)
    try {
      const next = await updateProjectExpenseAccountingAction(projectId, accountingExpense.id, {
        qboTransactionType: accountingDraft.qboTransactionType,
        qboExpenseAccountId: expenseAccount.id,
        qboExpenseAccountName: accountLabel(expenseAccount),
        qboPaymentAccountId: accountingDraft.qboTransactionType === "purchase" ? paymentAccount?.id ?? null : null,
        qboPaymentAccountName:
          accountingDraft.qboTransactionType === "purchase" && paymentAccount ? accountLabel(paymentAccount) : null,
        qboApAccountId: accountingDraft.qboTransactionType === "bill" ? apAccount?.id ?? null : null,
        qboApAccountName: accountingDraft.qboTransactionType === "bill" && apAccount ? accountLabel(apAccount) : null,
        qboVendorId: qboVendor?.id ?? null,
        qboVendorName: qboVendor ? accountLabel(qboVendor) : null,
      })
      setItems((next as ProjectExpense[]) ?? [])

      if (syncAfterSave) {
        await syncProjectExpenseToQBOAction(projectId, accountingExpense.id)
        toast.success("Expense coded and synced to QuickBooks")
      } else {
        toast.success("QuickBooks coding saved")
      }

      refresh()
      setAccountingExpense(null)
      setAccountingDraft(null)
    } catch (error: any) {
      toast.error(syncAfterSave ? "Could not save and sync" : "Could not save QuickBooks coding", {
        description: error?.message ?? "Please try again.",
      })
      refresh()
    } finally {
      setAccountingSaving(false)
    }
  }

  async function saveExpenseAccount(expense: ProjectExpense, accountId: string) {
    const account = findAccount(accountingContext?.expenseAccounts, accountId)
    if (!account) {
      toast.error("Choose a QuickBooks account")
      return
    }

    const draft = defaultAccountingDraft(expense, accountingContext)
    const paymentAccount = findAccount(accountingContext?.paymentAccounts, draft.qboPaymentAccountId)
    const apAccount = findAccount(accountingContext?.apAccounts, draft.qboApAccountId)
    const qboVendor =
      draft.qboVendorId === AUTO_QBO_VENDOR ? null : findAccount(accountingContext?.vendors, draft.qboVendorId)

    setSavingAccountExpenseId(expense.id)
    try {
      const next = await updateProjectExpenseAccountingAction(projectId, expense.id, {
        qboTransactionType: draft.qboTransactionType,
        qboExpenseAccountId: account.id,
        qboExpenseAccountName: accountLabel(account),
        qboPaymentAccountId:
          draft.qboTransactionType === "purchase"
            ? paymentAccount?.id ?? expense.qbo_payment_account_id ?? null
            : null,
        qboPaymentAccountName:
          draft.qboTransactionType === "purchase"
            ? paymentAccount
              ? accountLabel(paymentAccount)
              : expense.qbo_payment_account_name ?? null
            : null,
        qboApAccountId:
          draft.qboTransactionType === "bill"
            ? apAccount?.id ?? expense.qbo_ap_account_id ?? null
            : null,
        qboApAccountName:
          draft.qboTransactionType === "bill"
            ? apAccount
              ? accountLabel(apAccount)
              : expense.qbo_ap_account_name ?? null
            : null,
        qboVendorId: qboVendor?.id ?? expense.qbo_vendor_id ?? null,
        qboVendorName: qboVendor ? accountLabel(qboVendor) : expense.qbo_vendor_name ?? null,
      })
      setItems((next as ProjectExpense[]) ?? [])
      setOpenAccountExpenseId(null)
      toast.success("QuickBooks account saved")
    } catch (error: any) {
      toast.error("Could not save QuickBooks account", {
        description: error?.message ?? "Please try again.",
      })
      refresh()
    } finally {
      setSavingAccountExpenseId(null)
    }
  }

  function rowActions(expense: ProjectExpense) {
    const isSubmitted = expense.status === "submitted"
    const canSync = expense.status === "approved" && expense.qbo_sync_status !== "synced"
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity">
            <MoreHorizontal className="h-3.5 w-3.5" />
            <span className="sr-only">Expense actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openAccounting(expense)}>
            QuickBooks coding
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {isSubmitted ? (
            <>
              <DropdownMenuItem onClick={() => approve(expense.id)}>Approve</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => reject(expense.id)} className="text-destructive focus:text-destructive">
                Reject
              </DropdownMenuItem>
            </>
          ) : canSync ? (
            <DropdownMenuItem onClick={() => syncExpense(expense.id)}>Sync to QuickBooks</DropdownMenuItem>
          ) : (
            <DropdownMenuItem disabled>No actions available</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  return (
    <>
      <ExpenseForm
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        projectId={projectId}
        onSubmit={handleCreate}
        onExtractReceipt={handleExtract}
        accountingContext={accountingContext}
        initialReceipt={pendingReceipt}
        isSubmitting={isPending}
      />

      <Sheet open={Boolean(accountingExpense)} onOpenChange={closeAccounting}>
        <SheetContent side="right" className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] flex flex-col p-0 shadow-2xl">
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <SheetTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              QuickBooks coding
            </SheetTitle>
            <SheetDescription>
              {accountingExpense ? vendorOf(accountingExpense) : "Code this expense before syncing."}
            </SheetDescription>
          </SheetHeader>

          {accountingExpense && accountingDraft ? (
            <>
              <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
                {!accountingContext?.qboConnected ? (
                  <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                    Connect QuickBooks in integrations before coding expenses.
                  </div>
                ) : null}

                <div className="grid grid-cols-2 gap-3 rounded-lg border bg-card p-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">Amount</p>
                    <p className="mt-1 font-semibold tabular-nums">
                      {formatCurrency((accountingExpense.amount_cents ?? 0) + (accountingExpense.tax_cents ?? 0))}
                    </p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Current status</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <Badge variant="secondary" className={`border text-[10px] font-normal ${statusStyles[accountingExpense.status] ?? ""}`}>
                        {statusLabels[accountingExpense.status] ?? accountingExpense.status}
                      </Badge>
                      <ExpenseQBOStatus expense={accountingExpense} compact />
                    </div>
                  </div>
                </div>

                {accountingExpense.qbo_sync_error ? (
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                    {accountingExpense.qbo_sync_error}
                  </div>
                ) : null}

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Transaction type</Label>
                  <Select
                    value={accountingDraft.qboTransactionType}
                    onValueChange={(value) =>
                      setAccountingDraft((draft) =>
                        draft ? { ...draft, qboTransactionType: value as "purchase" | "bill" } : draft,
                      )
                    }
                    disabled={!accountingContext?.qboConnected || accountingSaving}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="purchase">Paid expense / purchase</SelectItem>
                      <SelectItem value="bill">Vendor bill due later</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">QBO vendor</Label>
                  <Select
                    value={accountingDraft.qboVendorId}
                    onValueChange={(value) =>
                      setAccountingDraft((draft) => (draft ? { ...draft, qboVendorId: value } : draft))
                    }
                    disabled={!accountingContext?.qboConnected || accountingSaving}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Match by expense vendor name" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO_QBO_VENDOR}>Match/create automatically</SelectItem>
                      {(accountingContext?.vendors ?? []).map((vendor) => (
                        <SelectItem key={vendor.id} value={vendor.id}>
                          {accountLabel(vendor)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Leave blank to match or create from the receipt vendor.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Account</Label>
                  <Select
                    value={accountingDraft.qboExpenseAccountId}
                    onValueChange={(value) =>
                      setAccountingDraft((draft) => (draft ? { ...draft, qboExpenseAccountId: value } : draft))
                    }
                    disabled={!accountingContext?.qboConnected || accountingSaving}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose account" />
                    </SelectTrigger>
                    <SelectContent>
                      {(accountingContext?.expenseAccounts ?? []).map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {accountLabel(account)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {accountingDraft.qboTransactionType === "bill" ? (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Accounts payable account</Label>
                    <Select
                      value={accountingDraft.qboApAccountId}
                      onValueChange={(value) =>
                        setAccountingDraft((draft) => (draft ? { ...draft, qboApAccountId: value } : draft))
                      }
                      disabled={!accountingContext?.qboConnected || accountingSaving}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Default AP account" />
                      </SelectTrigger>
                      <SelectContent>
                        {(accountingContext?.apAccounts ?? []).map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {accountLabel(account)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Paid from</Label>
                    <Select
                      value={accountingDraft.qboPaymentAccountId}
                      onValueChange={(value) =>
                        setAccountingDraft((draft) => (draft ? { ...draft, qboPaymentAccountId: value } : draft))
                      }
                      disabled={!accountingContext?.qboConnected || accountingSaving}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Bank or credit card" />
                      </SelectTrigger>
                      <SelectContent>
                        {(accountingContext?.paymentAccounts ?? []).map((account) => (
                          <SelectItem key={account.id} value={account.id}>
                            {accountLabel(account)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {qboDeepLink(accountingExpense) ? (
                  <Button variant="outline" size="sm" asChild>
                    <a href={qboDeepLink(accountingExpense)!} target="_blank" rel="noreferrer" className="gap-2">
                      <ExternalLink className="h-3.5 w-3.5" />
                      Open in QuickBooks
                    </a>
                  </Button>
                ) : null}
              </div>

              <SheetFooter className="border-t bg-background/80 px-6 py-3">
                <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void saveAccounting(false)}
                    disabled={!accountingContext?.qboConnected || accountingSaving}
                  >
                    {accountingSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    Save coding
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void saveAccounting(true)}
                    disabled={!accountingContext?.qboConnected || accountingSaving || accountingExpense.status !== "approved"}
                  >
                    {accountingSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-2 h-3.5 w-3.5" />}
                    Save & sync
                  </Button>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <div
        className="-mx-4 -mb-4 -mt-6 flex h-[calc(100svh-3.5rem)] min-h-0 flex-col overflow-hidden bg-background relative"
        onDragEnter={handlePageDragEnter}
        onDragOver={handlePageDragOver}
        onDragLeave={handlePageDragLeave}
        onDrop={handlePageDrop}
      >
        {isPageDragging ? (
          <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-sm">
            <div className="relative w-[min(520px,calc(100%-2rem))] overflow-hidden rounded-lg border border-primary/40 bg-background px-6 py-8 text-center shadow-2xl">
              <div className="receipt-scan-sweep absolute inset-0 opacity-70" />
              <div className="relative mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg border bg-primary/10">
                <Upload className="h-6 w-6 text-primary" />
              </div>
              <div className="relative space-y-1">
                <p className="text-sm font-semibold">Drop receipt to scan</p>
                <p className="text-xs text-muted-foreground">Arc will open the expense sheet and fill in the receipt details.</p>
              </div>
              <Sparkles className="absolute right-5 top-5 h-4 w-4 text-primary" />
            </div>
          </div>
        ) : null}
        <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              placeholder="Search vendor, code..."
              className="w-full sm:w-72"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusKey)}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {(["submitted", "approved", "rejected", "invoiced", "draft"] as StatusKey[]).map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabels[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button onClick={openBlankExpense} className="w-full sm:w-auto">
              <Plus className="mr-2 h-4 w-4" />
              New expense
            </Button>
          </div>
        </div>

        {isMobile ? (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="space-y-3">
              {filtered.map((expense) => (
                <div key={expense.id} className="rounded-lg border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground">{formatDate(expense.expense_date)}</span>
                        <Badge
                          variant="secondary"
                          className={`capitalize border text-[11px] ${statusStyles[expense.status] ?? ""}`}
                        >
                          {statusLabels[expense.status] ?? expense.status}
                        </Badge>
                      </div>
                      <p className="font-semibold mt-1 truncate">{vendorOf(expense)}</p>
                      <p className="text-xs text-muted-foreground mt-1 tabular-nums">
                        {formatCurrency((expense.amount_cents ?? 0) + (expense.tax_cents ?? 0))}
                      </p>
                      {expense.cost_code?.code ? (
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {expense.cost_code.code} {expense.cost_code.name}
                        </p>
                      ) : null}
                      <div className="mt-2 max-w-full">
                        <AccountCombobox
                          expense={expense}
                          context={accountingContext}
                          open={openAccountExpenseId === expense.id}
                          disabled={!accountingContext?.qboConnected || savingAccountExpenseId === expense.id}
                          saving={savingAccountExpenseId === expense.id}
                          onOpenChange={(open) => setOpenAccountExpenseId(open ? expense.id : null)}
                          onSelect={(accountId) => void saveExpenseAccount(expense, accountId)}
                        />
                      </div>
                      <ExpenseQBOStatus expense={expense} />
                    </div>
                    <div onClick={(event) => event.stopPropagation()}>{rowActions(expense)}</div>
                  </div>
                </div>
              ))}
              {filtered.length === 0 && (
                <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Receipt className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No expenses yet</p>
                      <p className="text-sm">Snap a receipt to log a job-site purchase.</p>
                    </div>
                    <Button onClick={openBlankExpense}>
                      <Plus className="mr-2 h-4 w-4" />
                      New expense
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="w-[120px] pl-4">Date</TableHead>
                  <TableHead className="w-[28%] min-w-[200px]">Vendor</TableHead>
                  <TableHead className="hidden md:table-cell w-[180px]">Cost code</TableHead>
                  <TableHead className="hidden xl:table-cell w-[220px]">Account</TableHead>
                  <TableHead className="hidden sm:table-cell w-[120px] text-center">Status</TableHead>
                  <TableHead className="hidden lg:table-cell w-[120px] text-right">Payment</TableHead>
                  <TableHead className="w-[120px] text-right">Amount</TableHead>
                  <TableHead className="w-[60px] pr-2" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((expense) => (
                  <TableRow key={expense.id} className="group h-[56px]">
                    <TableCell className="pl-4">
                      <span className="text-sm tabular-nums">{formatDate(expense.expense_date)}</span>
                    </TableCell>
                    <TableCell className="min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-medium truncate">{vendorOf(expense)}</span>
                        {expense.receipt_file_id ? (
                          <Paperclip className="h-3 w-3 text-muted-foreground" />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {expense.cost_code?.code ? (
                        <span className="text-xs text-muted-foreground truncate block">
                          <span className="font-medium text-foreground">{expense.cost_code.code}</span>{" "}
                          {expense.cost_code.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <AccountCombobox
                        expense={expense}
                        context={accountingContext}
                        open={openAccountExpenseId === expense.id}
                        disabled={!accountingContext?.qboConnected || savingAccountExpenseId === expense.id}
                        saving={savingAccountExpenseId === expense.id}
                        onOpenChange={(open) => setOpenAccountExpenseId(open ? expense.id : null)}
                        onSelect={(accountId) => void saveExpenseAccount(expense, accountId)}
                      />
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-center">
                      <Badge
                        variant="secondary"
                        className={`text-[10px] px-1.5 py-0 h-4 font-normal capitalize border ${statusStyles[expense.status] ?? ""}`}
                      >
                        {statusLabels[expense.status] ?? expense.status}
                      </Badge>
                      <ExpenseQBOStatus expense={expense} compact />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-right text-xs text-muted-foreground capitalize">
                      {expense.payment_method ? expense.payment_method.replaceAll("_", " ") : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-medium">
                      {formatCurrency((expense.amount_cents ?? 0) + (expense.tax_cents ?? 0))}
                    </TableCell>
                    <TableCell className="pr-2" onClick={(event) => event.stopPropagation()}>
                      <div className="flex items-center justify-end">{rowActions(expense)}</div>
                    </TableCell>
                  </TableRow>
                ))}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={8} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <Receipt className="h-6 w-6" />
                        </div>
                        <div className="text-center max-w-[400px]">
                          <p className="font-medium">No expenses yet</p>
                          <p className="text-sm text-muted-foreground mt-0.5">
                            Snap a receipt to log a job-site purchase.
                          </p>
                        </div>
                        <div className="mt-2">
                          <Button variant="default" size="sm" onClick={openBlankExpense}>
                            <Plus className="mr-2 h-4 w-4" />
                            New expense
                          </Button>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </>
  )
}
