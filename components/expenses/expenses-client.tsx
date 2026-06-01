"use client"

import { type DragEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import { useIsMobile } from "@/hooks/use-mobile"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Check, CheckCircle2, ChevronsUpDown, Clock, ExternalLink, Loader2, MoreHorizontal, Plus, Receipt, RefreshCcw, SlidersHorizontal, Sparkles, Upload, XCircle } from "@/components/icons"

import {
  approveProjectExpenseFormAction,
  createMyExpenseAction,
  extractExpenseReceiptAction,
  getExpenseAccountingContextAction,
  listProjectExpensesAction,
  rejectProjectExpenseFormAction,
  syncProjectExpenseToQBOAction,
  updateProjectExpenseAccountingAction,
  updateProjectExpenseDetailsAction,
  type CreateMyExpenseInput,
  type ReceiptExtractionResult,
} from "@/app/(app)/projects/[id]/expenses/actions"
import { getFileAction, getFileDownloadUrlAction } from "@/app/(app)/documents/actions"
import { ExpenseForm } from "@/components/expenses/expense-form"
import { FileViewer } from "@/components/files/file-viewer"
import type { FileWithDetails } from "@/components/files/types"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"
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
  cost_code_id?: string | null
  cost_code?: { code?: string | null; name?: string | null } | null
}

interface ExpensesClientProps {
  projectId: string
  initialExpenses: ProjectExpense[]
}

type ExpenseAccountingContext = Awaited<ReturnType<typeof getExpenseAccountingContextAction>>
type AccountingDraft = {
  qboExpenseAccountId: string
  qboPaymentAccountId: string
  qboVendorId: string
}

type QueueFilter = "all" | "needs_review" | "ready" | "synced"

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
  return ((cents ?? 0) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  })
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

function initialsFor(value: string) {
  const parts = value
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (parts.length === 0) return "EX"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase()
}

function accountLabel(account: { name: string; fullyQualifiedName?: string }) {
  return account.fullyQualifiedName ?? account.name
}

function costCodeLabel(code: { code?: string | null; name?: string | null }) {
  return `${code.code ?? ""} ${code.name ?? ""}`.trim() || "Cost code"
}

function IconTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function findAccount(accounts: { id: string; name: string; fullyQualifiedName?: string }[] | undefined, id: string) {
  return (accounts ?? []).find((account) => account.id === id) ?? null
}

function defaultAccountingDraft(expense: ProjectExpense, context: ExpenseAccountingContext | null): AccountingDraft {
  return {
    qboExpenseAccountId: expense.qbo_expense_account_id ?? context?.defaults?.expenseAccountId ?? "",
    qboPaymentAccountId: expense.qbo_payment_account_id ?? (expense.payment_method === "company_card" ? context?.defaults?.creditCardAccountId : context?.defaults?.paymentAccountId) ?? "",
    qboVendorId: expense.qbo_vendor_id ?? AUTO_QBO_VENDOR,
  }
}

function hasRequiredQboCoding(expense: ProjectExpense) {
  if (!expense.qbo_expense_account_id) return false
  return Boolean(expense.qbo_payment_account_id)
}

function needsQboReview(expense: ProjectExpense) {
  if (expense.qbo_sync_status === "needs_review" || expense.qbo_sync_status === "error") return true
  return expense.status === "approved" && expense.qbo_sync_status !== "synced" && !hasRequiredQboCoding(expense)
}

function readyForQboSync(expense: ProjectExpense) {
  return expense.status === "approved" && expense.qbo_sync_status !== "synced" && !needsQboReview(expense)
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
  const selectedAccount = expense.qbo_expense_account_id ? findAccount(accounts, expense.qbo_expense_account_id) : null
  const selectedName = selectedAccount?.name ?? expense.qbo_expense_account_name?.split(":").pop()?.trim() ?? "Choose account"
  const selectedPath = selectedAccount?.fullyQualifiedName ?? expense.qbo_expense_account_name ?? "QBO category"

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" role="combobox" aria-expanded={open} disabled={disabled} className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left">
          <span className="flex min-w-0 items-center">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">{selectedName}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{selectedPath}</span>
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search accounts..." />
          <CommandList>
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup heading="Accounts">
              {accounts.map((account) => {
                const label = accountLabel(account)
                const selected = account.id === expense.qbo_expense_account_id
                return (
                  <CommandItem key={account.id} value={`${label} ${account.accountType ?? ""}`} onSelect={() => onSelect(account.id)}>
                    <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{account.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{account.fullyQualifiedName ?? account.accountType ?? label}</span>
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

function VendorCombobox({
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
  onSelect: (vendorId: string) => void
}) {
  const vendors = context?.vendors ?? []
  const selectedLabel = expense.qbo_vendor_name ?? vendorOf(expense)

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" role="combobox" aria-expanded={open} disabled={disabled} className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left">
          <span className="flex min-w-0 items-center">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">{selectedLabel}</span>
              <span className="block truncate text-[11px] text-muted-foreground">QuickBooks vendor</span>
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search vendors..." />
          <CommandList>
            <CommandEmpty>No vendors found.</CommandEmpty>
            <CommandGroup heading="Vendors">
              <CommandItem value="Auto match/create" onSelect={() => onSelect(AUTO_QBO_VENDOR)}>
                <Check className={cn("size-4", expense.qbo_vendor_id ? "opacity-0" : "opacity-100")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">Auto match/create</span>
                  <span className="block truncate text-xs text-muted-foreground">Use the merchant name on sync</span>
                </span>
              </CommandItem>
              {vendors.map((vendor) => {
                const selected = vendor.id === expense.qbo_vendor_id
                return (
                  <CommandItem key={vendor.id} value={vendor.name} onSelect={() => onSelect(vendor.id)}>
                    <Check className={cn("size-4", selected ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{vendor.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">QuickBooks vendor</span>
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

function CostCodeCombobox({
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
  onSelect: (costCodeId: string | null) => void
}) {
  const costCodes = context?.costCodes ?? []
  const selected = expense.cost_code ?? null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" role="combobox" aria-expanded={open} disabled={disabled} className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left">
          <span className="flex min-w-0 items-center">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-foreground">{selected?.code ?? "Choose code"}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{selected ? costCodeLabel(selected) : "Project cost code"}</span>
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search cost codes..." />
          <CommandList>
            <CommandEmpty>No cost codes found.</CommandEmpty>
            <CommandGroup heading="Cost codes">
              <CommandItem value="No cost code" onSelect={() => onSelect(null)}>
                <Check className={cn("size-4", expense.cost_code_id ? "opacity-0" : "opacity-100")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">No cost code</span>
                  <span className="block truncate text-xs text-muted-foreground">Leave uncoded</span>
                </span>
              </CommandItem>
              {costCodes.map((code: any) => {
                const selectedCode = code.id === expense.cost_code_id
                return (
                  <CommandItem key={code.id} value={costCodeLabel(code)} onSelect={() => onSelect(code.id)}>
                    <Check className={cn("size-4", selectedCode ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{code.code}</span>
                      <span className="block truncate text-xs text-muted-foreground">{costCodeLabel(code)}</span>
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

function ExpenseStatusIcon({ status }: { status: string }) {
  const label = statusLabels[status] ?? status
  if (status === "approved" || status === "invoiced") {
    return (
      <span title={label}>
        <CheckCircle2 className="h-4 w-4 text-success" aria-label={label} />
      </span>
    )
  }
  if (status === "rejected") {
    return (
      <span title={label}>
        <XCircle className="h-4 w-4 text-destructive" aria-label={label} />
      </span>
    )
  }
  return (
    <span title={label}>
      <Clock className="h-4 w-4 text-muted-foreground" aria-label={label} />
    </span>
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
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all")
  const [sheetOpen, setSheetOpen] = useState(false)
  const [syncSheetOpen, setSyncSheetOpen] = useState(false)
  const [isPageDragging, setIsPageDragging] = useState(false)
  const [pendingReceipt, setPendingReceipt] = useState<PendingReceipt | null>(null)
  const [accountingContext, setAccountingContext] = useState<ExpenseAccountingContext | null>(null)
  const [accountingExpense, setAccountingExpense] = useState<ProjectExpense | null>(null)
  const [accountingDraft, setAccountingDraft] = useState<AccountingDraft | null>(null)
  const [accountingSaving, setAccountingSaving] = useState(false)
  const [openAccountExpenseId, setOpenAccountExpenseId] = useState<string | null>(null)
  const [savingAccountExpenseId, setSavingAccountExpenseId] = useState<string | null>(null)
  const [openVendorExpenseId, setOpenVendorExpenseId] = useState<string | null>(null)
  const [savingVendorExpenseId, setSavingVendorExpenseId] = useState<string | null>(null)
  const [openCostCodeExpenseId, setOpenCostCodeExpenseId] = useState<string | null>(null)
  const [savingCostCodeExpenseId, setSavingCostCodeExpenseId] = useState<string | null>(null)
  const [savingMemoExpenseId, setSavingMemoExpenseId] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<FileWithDetails | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const dragDepthRef = useRef(0)
  const [isPending, startTransition] = useTransition()

  const filtered = useMemo(() => {
    const term = search.toLowerCase().trim()
    return items.filter((expense) => {
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
        expense.cost_code?.code ?? "",
        expense.cost_code?.name ?? "",
        expense.qbo_expense_account_name ?? "",
        expense.qbo_payment_account_name ?? "",
        expense.qbo_ap_account_name ?? "",
        expense.qbo_vendor_name ?? "",
        expense.expense_date ?? "",
      ].some((value) => String(value).toLowerCase().includes(term))
    })
  }, [items, search, queueFilter])

  const filterCounts = useMemo(
    () => ({
      all: items.length,
      needs_review: items.filter(needsQboReview).length,
      ready: items.filter(readyForQboSync).length,
      synced: items.filter((expense) => expense.qbo_sync_status === "synced").length,
    }),
    [items],
  )

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

  const visibleIds = useMemo(() => filtered.map((expense) => expense.id), [filtered])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.includes(id)) && !allVisibleSelected

  function toggleSelectAll(checked: boolean | "indeterminate") {
    if (checked) {
      setSelectedIds((current) => Array.from(new Set([...current, ...visibleIds])))
    } else {
      setSelectedIds((current) => current.filter((id) => !visibleIds.includes(id)))
    }
  }

  function toggleSelectOne(id: string, checked: boolean | "indeterminate") {
    if (checked) {
      setSelectedIds((current) => (current.includes(id) ? current : [...current, id]))
    } else {
      setSelectedIds((current) => current.filter((itemId) => itemId !== id))
    }
  }

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
          toast.error("Could not submit receipt", {
            description: error?.message ?? "Please try again.",
          })
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

  async function openReceiptPreview(expense: ProjectExpense) {
    if (!expense.receipt_file_id) return
    const fallbackUrl = `/api/files/${expense.receipt_file_id}/raw`
    const fallbackFile: FileWithDetails = {
      id: expense.receipt_file_id,
      org_id: "",
      project_id: projectId,
      file_name: `${vendorOf(expense)} receipt`,
      storage_path: "",
      mime_type: "application/pdf",
      size_bytes: 0,
      visibility: "private",
      category: "financials",
      created_at: expense.expense_date ?? new Date().toISOString(),
      download_url: fallbackUrl,
    }

    setViewerFile(fallbackFile)
    setViewerOpen(true)

    try {
      const file = await getFileAction(expense.receipt_file_id)
      if (!file) return
      const downloadUrl = await getFileDownloadUrlAction(file.id)
      setViewerFile({
        ...(file as FileWithDetails),
        category: (file.category ?? "financials") as FileWithDetails["category"],
        download_url: downloadUrl,
        thumbnail_url: file.mime_type?.startsWith("image/") ? downloadUrl : undefined,
      })
    } catch (error: any) {
      toast.error("Could not load receipt preview", { description: error?.message ?? "Try again." })
    }
  }

  async function handleDownloadFile(file: FileWithDetails) {
    try {
      const url = await getFileDownloadUrlAction(file.id)
      window.open(url, "_blank", "noopener,noreferrer")
    } catch (error: any) {
      toast.error("Could not download file", { description: error?.message ?? "Try again." })
    }
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
        toast.error("Could not sync to QuickBooks", {
          description: error?.message,
        })
        refresh()
      }
    })
  }

  async function saveAccounting(syncAfterSave = false) {
    if (!accountingExpense || !accountingDraft) return
    const expenseAccount = findAccount(accountingContext?.expenseAccounts, accountingDraft.qboExpenseAccountId)
    const paymentAccount = findAccount(accountingContext?.paymentAccounts, accountingDraft.qboPaymentAccountId)
    const qboVendor = accountingDraft.qboVendorId === AUTO_QBO_VENDOR ? null : findAccount(accountingContext?.vendors, accountingDraft.qboVendorId)

    if (!expenseAccount) {
      toast.error("Choose a QuickBooks account")
      return
    }
    if (!paymentAccount) {
      toast.error("Choose the QuickBooks account this was paid from")
      return
    }

    setAccountingSaving(true)
    try {
      const next = await updateProjectExpenseAccountingAction(projectId, accountingExpense.id, {
        qboTransactionType: "purchase",
        qboExpenseAccountId: expenseAccount.id,
        qboExpenseAccountName: accountLabel(expenseAccount),
        qboPaymentAccountId: paymentAccount.id,
        qboPaymentAccountName: accountLabel(paymentAccount),
        qboApAccountId: null,
        qboApAccountName: null,
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
    const qboVendor = draft.qboVendorId === AUTO_QBO_VENDOR ? null : findAccount(accountingContext?.vendors, draft.qboVendorId)

    setSavingAccountExpenseId(expense.id)
    setOpenAccountExpenseId(null)
    setItems((current) =>
      current.map((item) =>
        item.id === expense.id
          ? { ...item, qbo_expense_account_id: account.id, qbo_expense_account_name: accountLabel(account) }
          : item,
      ),
    )
    try {
      const next = await updateProjectExpenseAccountingAction(projectId, expense.id, {
        qboTransactionType: "purchase",
        qboExpenseAccountId: account.id,
        qboExpenseAccountName: accountLabel(account),
        qboPaymentAccountId: paymentAccount?.id ?? expense.qbo_payment_account_id ?? null,
        qboPaymentAccountName: paymentAccount ? accountLabel(paymentAccount) : (expense.qbo_payment_account_name ?? null),
        qboApAccountId: null,
        qboApAccountName: null,
        qboVendorId: qboVendor?.id ?? expense.qbo_vendor_id ?? null,
        qboVendorName: qboVendor ? accountLabel(qboVendor) : (expense.qbo_vendor_name ?? null),
      })
      setItems((next as ProjectExpense[]) ?? [])
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

  async function saveExpenseVendor(expense: ProjectExpense, vendorId: string) {
    const qboVendor = vendorId === AUTO_QBO_VENDOR ? null : findAccount(accountingContext?.vendors, vendorId)
    if (vendorId !== AUTO_QBO_VENDOR && !qboVendor) {
      toast.error("Choose a QuickBooks vendor")
      return
    }

    setSavingVendorExpenseId(expense.id)
    setOpenVendorExpenseId(null)
    setItems((current) =>
      current.map((item) =>
        item.id === expense.id
          ? { ...item, qbo_vendor_id: qboVendor?.id ?? null, qbo_vendor_name: qboVendor ? accountLabel(qboVendor) : null }
          : item,
      ),
    )
    try {
      const next = await updateProjectExpenseAccountingAction(projectId, expense.id, {
        qboTransactionType: "purchase",
        qboExpenseAccountId: expense.qbo_expense_account_id ?? null,
        qboExpenseAccountName: expense.qbo_expense_account_name ?? null,
        qboPaymentAccountId: expense.qbo_payment_account_id ?? null,
        qboPaymentAccountName: expense.qbo_payment_account_name ?? null,
        qboApAccountId: null,
        qboApAccountName: null,
        qboVendorId: qboVendor?.id ?? null,
        qboVendorName: qboVendor ? accountLabel(qboVendor) : null,
      })
      setItems((next as ProjectExpense[]) ?? [])
      toast.success("QuickBooks vendor saved")
    } catch (error: any) {
      toast.error("Could not save QuickBooks vendor", {
        description: error?.message ?? "Please try again.",
      })
      refresh()
    } finally {
      setSavingVendorExpenseId(null)
    }
  }

  async function saveExpenseMemo(expense: ProjectExpense, description: string) {
    setSavingMemoExpenseId(expense.id)
    setItems((current) => current.map((item) => (item.id === expense.id ? { ...item, description } : item)))
    try {
      const next = await updateProjectExpenseDetailsAction(projectId, expense.id, { description })
      setItems((next as ProjectExpense[]) ?? [])
    } catch (error: any) {
      toast.error("Could not save memo", { description: error?.message ?? "Please try again." })
      refresh()
    } finally {
      setSavingMemoExpenseId(null)
    }
  }

  async function saveExpenseCostCode(expense: ProjectExpense, costCodeId: string | null) {
    const costCode = (accountingContext?.costCodes ?? []).find((code: any) => code.id === costCodeId) ?? null
    setSavingCostCodeExpenseId(expense.id)
    setOpenCostCodeExpenseId(null)
    setItems((current) =>
      current.map((item) =>
        item.id === expense.id
          ? {
              ...item,
              cost_code_id: costCode?.id ?? null,
              cost_code: costCode ? { code: costCode.code, name: costCode.name } : null,
            }
          : item,
      ),
    )
    try {
      const next = await updateProjectExpenseDetailsAction(projectId, expense.id, { costCodeId })
      setItems((next as ProjectExpense[]) ?? [])
      toast.success("Cost code saved")
    } catch (error: any) {
      toast.error("Could not save cost code", { description: error?.message ?? "Please try again." })
      refresh()
    } finally {
      setSavingCostCodeExpenseId(null)
    }
  }

  function rowActions(expense: ProjectExpense) {
    const isSubmitted = expense.status === "submitted"
    const canSync = expense.status === "approved" && expense.qbo_sync_status !== "synced"
    return (
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-9 w-9">
                <MoreHorizontal className="h-4 w-4" />
                <span className="sr-only">Expense actions</span>
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent>More actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => openAccounting(expense)}>Edit</DropdownMenuItem>
          <DropdownMenuItem onClick={() => openAccounting(expense)}>QuickBooks coding</DropdownMenuItem>
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

  function rowApproveAction(expense: ProjectExpense) {
    const isSubmitted = expense.status === "submitted"
    return (
      <IconTooltip label={isSubmitted ? "Approve expense" : "Only submitted expenses can be approved"}>
        <span>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className={cn(
              "h-9 w-9 rounded-md bg-background",
              isSubmitted
                ? "border-emerald-600 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
                : "border-muted text-muted-foreground opacity-70",
            )}
            disabled={isPending || !isSubmitted}
            onClick={() => approve(expense.id)}
          >
            <Check className="h-5 w-5" />
            <span className="sr-only">Approve expense</span>
          </Button>
        </span>
      </IconTooltip>
    )
  }

  return (
    <TooltipProvider>
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

      <QboSyncSheet open={syncSheetOpen} onOpenChange={setSyncSheetOpen} />

      <Sheet open={Boolean(accountingExpense)} onOpenChange={closeAccounting}>
        <SheetContent side="right" className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] flex flex-col p-0 shadow-2xl">
          <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
            <SheetTitle className="flex items-center gap-2">
              <SlidersHorizontal className="h-4 w-4 text-primary" />
              QuickBooks coding
            </SheetTitle>
            <SheetDescription>{accountingExpense ? vendorOf(accountingExpense) : "Code this expense before syncing."}</SheetDescription>
          </SheetHeader>

          {accountingExpense && accountingDraft ? (
            <>
              <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
                {!accountingContext?.qboConnected ? (
                  <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">Connect QuickBooks in integrations before coding expenses.</div>
                ) : null}

                <div className="grid grid-cols-2 gap-3 rounded-lg border bg-card p-3 text-xs">
                  <div>
                    <p className="text-muted-foreground">Amount</p>
                    <p className="mt-1 font-semibold tabular-nums">{formatCurrency((accountingExpense.amount_cents ?? 0) + (accountingExpense.tax_cents ?? 0))}</p>
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
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">{accountingExpense.qbo_sync_error}</div>
                ) : null}

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">QBO vendor</Label>
                  <Select
                    value={accountingDraft.qboVendorId}
                    onValueChange={(value) => setAccountingDraft((draft) => (draft ? { ...draft, qboVendorId: value } : draft))}
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
                  <p className="text-xs text-muted-foreground">Leave blank to match or create from the receipt vendor.</p>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Account</Label>
                  <Select
                    value={accountingDraft.qboExpenseAccountId}
                    onValueChange={(value) => setAccountingDraft((draft) => (draft ? { ...draft, qboExpenseAccountId: value } : draft))}
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

                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Paid from</Label>
                  <Select
                    value={accountingDraft.qboPaymentAccountId}
                    onValueChange={(value) => setAccountingDraft((draft) => (draft ? { ...draft, qboPaymentAccountId: value } : draft))}
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
                  <Button type="button" variant="outline" onClick={() => void saveAccounting(false)} disabled={!accountingContext?.qboConnected || accountingSaving}>
                    {accountingSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    Save coding
                  </Button>
                  <Button type="button" onClick={() => void saveAccounting(true)} disabled={!accountingContext?.qboConnected || accountingSaving || accountingExpense.status !== "approved"}>
                    {accountingSaving ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-2 h-3.5 w-3.5" />}
                    Save & sync
                  </Button>
                </div>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <FileViewer
        file={viewerFile}
        files={viewerFile ? [viewerFile] : []}
        open={viewerOpen}
        onOpenChange={(open) => {
          setViewerOpen(open)
          if (!open) setViewerFile(null)
        }}
        onDownload={handleDownloadFile}
      />

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
            <Input placeholder="Search vendor, code..." className="h-[42px] w-full sm:w-72" value={search} onChange={(event) => setSearch(event.target.value)} />
            <div className="flex w-full overflow-x-auto border bg-muted/20 p-1 sm:w-auto">
              {([
                { key: "all", label: "All" },
                { key: "needs_review", label: "Needs coding" },
                { key: "ready", label: "Ready to sync" },
                { key: "synced", label: "Synced" },
              ] as Array<{ key: QueueFilter; label: string }>).map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => setQueueFilter(filter.key)}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-medium transition-colors",
                    queueFilter === filter.key
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{filter.label}</span>
                  <span className={cn(
                    "px-1.5 py-0.5 text-[10px] tabular-nums",
                    queueFilter === filter.key ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground",
                  )}>
                    {filterCounts[filter.key]}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button type="button" variant="outline" onClick={() => setSyncSheetOpen(true)} className="w-full sm:w-auto">
              <RefreshCcw className="mr-2 h-4 w-4" />
              Sync all
            </Button>
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
                    <Checkbox
                      checked={selectedIds.includes(expense.id)}
                      onCheckedChange={(checked) => toggleSelectOne(expense.id, checked)}
                      aria-label={`Select expense ${vendorOf(expense)}`}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium text-muted-foreground">{formatDate(expense.expense_date)}</span>
                        <Badge variant="secondary" className={`capitalize border text-[11px] ${statusStyles[expense.status] ?? ""}`}>
                          {statusLabels[expense.status] ?? expense.status}
                        </Badge>
                      </div>
                      <p className="font-semibold mt-1 truncate">{vendorOf(expense)}</p>
                      <p className="text-xs text-muted-foreground mt-1 tabular-nums">{formatCurrency((expense.amount_cents ?? 0) + (expense.tax_cents ?? 0))}</p>
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
            <Table className="min-w-[1480px]">
              <TableHeader>
                <TableRow className="divide-x">
                  <TableHead className="relative w-[72px] min-w-[72px] py-3 text-center">
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Checkbox checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false} onCheckedChange={toggleSelectAll} aria-label="Select all expenses" />
                    </div>
                  </TableHead>
                  <TableHead className="min-w-[220px] px-4 py-3">Merchant / Vendor</TableHead>
                  <TableHead className="w-[132px] px-4 py-3 text-center">Date</TableHead>
                  <TableHead className="w-[168px] px-4 py-3 text-right">Amount</TableHead>
                  <TableHead className="min-w-[340px] px-4 py-3">QBO Category</TableHead>
                  <TableHead className="w-[96px] px-4 py-3 text-center">Receipt</TableHead>
                  <TableHead className="min-w-[220px] px-4 py-3">Memo</TableHead>
                  <TableHead className="min-w-[280px] px-4 py-3">QBO Vendor</TableHead>
                  <TableHead className="min-w-[180px] px-4 py-3">Cost Code</TableHead>
                  <TableHead className="sticky right-[56px] z-10 w-14 min-w-14 border-l-2 border-r bg-background px-2 py-3 text-center shadow-[-2px_0_0_hsl(var(--border))]">
                    <span className="sr-only">Approve</span>
                  </TableHead>
                  <TableHead className="sticky right-0 z-10 w-14 min-w-14 border-l bg-background px-2 py-3 text-center shadow-[-1px_0_0_hsl(var(--border))]">
                    <span className="sr-only">More actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((expense) => {
                  const vendor = vendorOf(expense)
                  const amount = (expense.amount_cents ?? 0) + (expense.tax_cents ?? 0)
                  return (
                    <TableRow key={expense.id} data-state={selectedIds.includes(expense.id) ? "selected" : undefined} className="divide-x align-middle">
                      <TableCell className="relative w-[72px] min-w-[72px] py-2 text-center align-middle">
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Checkbox checked={selectedIds.includes(expense.id)} onCheckedChange={(checked) => toggleSelectOne(expense.id, checked)} aria-label={`Select expense ${vendor}`} />
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2">
                        <div className="flex min-w-0 items-center gap-3">
                          <Avatar className="size-7 rounded-md">
                            <AvatarFallback className="rounded-md text-[11px] font-semibold">{initialsFor(vendor)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{vendor}</div>
                          </div>
                          <IconTooltip label={statusLabels[expense.status] ?? expense.status}>
                            <span className="ml-auto flex shrink-0 items-center justify-center">
                              <ExpenseStatusIcon status={expense.status} />
                            </span>
                          </IconTooltip>
                        </div>
                      </TableCell>
                      <TableCell className="px-4 py-2 text-center text-sm tabular-nums text-muted-foreground">{formatDate(expense.expense_date)}</TableCell>
                      <TableCell className="px-4 py-2 text-right text-sm font-semibold tabular-nums">{formatCurrency(amount)}</TableCell>
                      <TableCell className="p-0">
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
                      <TableCell className="px-4 py-2 text-center">
                        {expense.receipt_file_id ? (
                          <IconTooltip label="Preview receipt">
                            <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => void openReceiptPreview(expense)}>
                              <Receipt className="h-5 w-5 text-primary" />
                              <span className="sr-only">Preview receipt</span>
                            </Button>
                          </IconTooltip>
                        ) : (
                          <IconTooltip label="No receipt uploaded">
                            <span className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground" aria-label="No receipt uploaded">
                              <Receipt className="h-5 w-5 opacity-40" />
                            </span>
                          </IconTooltip>
                        )}
                      </TableCell>
                      <TableCell className="max-w-[260px] p-0">
                        <Input
                          value={expense.description ?? ""}
                          placeholder="Memo"
                          className="h-full min-h-11 rounded-none border-0 bg-transparent px-3 shadow-none focus-visible:ring-0"
                          disabled={savingMemoExpenseId === expense.id}
                          onChange={(event) => {
                            const description = event.target.value
                            setItems((current) => current.map((item) => (item.id === expense.id ? { ...item, description } : item)))
                          }}
                          onBlur={(event) => void saveExpenseMemo(expense, event.target.value)}
                        />
                      </TableCell>
                      <TableCell className="p-0">
                        <VendorCombobox
                          expense={expense}
                          context={accountingContext}
                          open={openVendorExpenseId === expense.id}
                          disabled={!accountingContext?.qboConnected || savingVendorExpenseId === expense.id}
                          saving={savingVendorExpenseId === expense.id}
                          onOpenChange={(open) => setOpenVendorExpenseId(open ? expense.id : null)}
                          onSelect={(vendorId) => void saveExpenseVendor(expense, vendorId)}
                        />
                      </TableCell>
                      <TableCell className="p-0">
                        <CostCodeCombobox
                          expense={expense}
                          context={accountingContext}
                          open={openCostCodeExpenseId === expense.id}
                          disabled={savingCostCodeExpenseId === expense.id}
                          saving={savingCostCodeExpenseId === expense.id}
                          onOpenChange={(open) => setOpenCostCodeExpenseId(open ? expense.id : null)}
                          onSelect={(costCodeId) => void saveExpenseCostCode(expense, costCodeId)}
                        />
                      </TableCell>
                      <TableCell className="sticky right-[56px] z-10 w-14 min-w-14 border-l-2 border-r bg-background px-2 py-2 text-center shadow-[-2px_0_0_hsl(var(--border))]" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-center">{rowApproveAction(expense)}</div>
                      </TableCell>
                      <TableCell className="sticky right-0 z-10 w-14 min-w-14 border-l bg-background px-2 py-2 text-center shadow-[-1px_0_0_hsl(var(--border))]" onClick={(event) => event.stopPropagation()}>
                        <div className="flex items-center justify-center">{rowActions(expense)}</div>
                      </TableCell>
                    </TableRow>
                  )
                })}
                {filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                          <Receipt className="h-6 w-6" />
                        </div>
                        <div className="text-center max-w-[400px]">
                          <p className="font-medium">No expenses yet</p>
                          <p className="text-sm text-muted-foreground mt-0.5">Snap a receipt to log a job-site purchase.</p>
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
    </TooltipProvider>
  )
}
