"use client"

import { type ReactNode, useMemo, useState } from "react"
import { format } from "date-fns"
import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  Clock,
  MoreHorizontal,
  Plus,
  Receipt,
  Search,
  Trash2,
  ExternalLink,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import { filterPayables, payableQueueCounts, type PayableQueue } from "./payables-filters"

type QBOAccountOption = { id: string; name: string; fullyQualifiedName?: string }

interface PayablesExplorerProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  costCodesEnabled?: boolean
  qboExpenseAccounts?: QBOAccountOption[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  onAddPayable?: () => void
  onViewDetails?: (bill: VendorBillSummary) => void
  onApprove?: (bill: VendorBillSummary) => void
  onRecordPayment?: (bill: VendorBillSummary) => void
  onSyncQbo?: (bill: VendorBillSummary) => void
  onOpenSyncSheet?: () => void
  onDelete?: (bill: VendorBillSummary) => void
  onViewFiles?: (bill: VendorBillSummary) => void
  onEditVendor?: (bill: VendorBillSummary) => void
  onSelectCostCode?: (bill: VendorBillSummary, costCodeId: string | null) => void
  onSelectQboExpenseAccount?: (bill: VendorBillSummary, accountId: string) => void
  toolbarLeading?: ReactNode
  fullBleed?: boolean
}

export function PayablesExplorer({
  vendorBills,
  costCodes,
  costCodesEnabled = true,
  qboExpenseAccounts = [],
  complianceRules,
  complianceStatusByCompanyId,
  onAddPayable,
  onViewDetails,
  onApprove,
  onRecordPayment,
  onSyncQbo,
  onOpenSyncSheet,
  onDelete,
  onViewFiles,
  onEditVendor,
  onSelectCostCode,
  onSelectQboExpenseAccount,
  toolbarLeading,
  fullBleed = false,
}: PayablesExplorerProps) {
  const [search, setSearch] = useState("")
  const [queueFilter, setQueueFilter] = useState<PayableQueue>("needs_review")
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [openCostCodeBillId, setOpenCostCodeBillId] = useState<string | null>(null)
  const [openQboAccountBillId, setOpenQboAccountBillId] = useState<string | null>(null)

  const filtered = useMemo(
    () => filterPayables(vendorBills, { search, queue: queueFilter, costCodesEnabled }),
    [costCodesEnabled, vendorBills, search, queueFilter],
  )

  const filterCounts = useMemo(
    () => payableQueueCounts(vendorBills, costCodesEnabled),
    [costCodesEnabled, vendorBills],
  )

  const visibleIds = filtered.map((bill) => bill.id)
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id))
  const someVisibleSelected = visibleIds.some((id) => selectedIds.includes(id))

  function toggleSelectAll(checked: boolean | "indeterminate") {
    if (checked) {
      setSelectedIds((current) => Array.from(new Set([...current, ...visibleIds])))
    } else {
      setSelectedIds((current) => current.filter((id) => !visibleIds.includes(id)))
    }
  }

  function toggleSelectOne(id: string, checked: boolean | "indeterminate") {
    setSelectedIds((current) => checked ? Array.from(new Set([...current, id])) : current.filter((item) => item !== id))
  }

  return (
    <div className={fullBleed ? "flex h-full w-full flex-col overflow-hidden bg-background" : "flex h-full flex-col overflow-hidden bg-background"}>
      <div className="sticky top-0 z-20 flex shrink-0 flex-col gap-3 border-b bg-background px-4 py-3 sm:min-h-14 sm:flex-row sm:items-center sm:justify-between">
        {toolbarLeading ? <div className="min-w-0">{toolbarLeading}</div> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search vendor, bill..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-[42px] rounded-none bg-muted/30 pl-9 shadow-none"
            />
          </div>
          <div className="flex w-full overflow-x-auto border bg-muted/20 p-1 sm:w-auto">
            {([
              { key: "all", label: "All" },
              { key: "needs_review", label: "Needs review" },
              { key: "ready", label: "Ready to sync" },
              { key: "synced", label: "Synced" },
            ] as const).map((filter) => (
              <button
                key={filter.key}
                type="button"
                onClick={() => setQueueFilter(filter.key)}
                className={cn(
                  "flex h-8 shrink-0 items-center gap-1.5 px-3 text-xs font-medium transition-colors",
                  queueFilter === filter.key ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{filter.label}</span>
                <span className={cn("px-1.5 py-0.5 text-[10px] tabular-nums", queueFilter === filter.key ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground")}>
                  {filterCounts[filter.key]}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <Button type="button" variant="outline" onClick={onOpenSyncSheet} className="w-full sm:w-auto">
            <ExternalLink className="mr-2 h-4 w-4" />
            QuickBooks
          </Button>
          <Button type="button" onClick={onAddPayable} className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            New payable
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <Table className={costCodesEnabled ? "min-w-[1540px]" : "min-w-[1320px]"}>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="relative w-[72px] min-w-[72px] py-3 text-center">
                <div className="absolute inset-0 flex items-center justify-center">
                  <Checkbox checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false} onCheckedChange={toggleSelectAll} aria-label="Select all payables" />
                </div>
              </TableHead>
              <TableHead className="min-w-[240px] px-4 py-3">Vendor / Company</TableHead>
              <TableHead className="w-[132px] px-4 py-3 text-center">Due Date</TableHead>
              <TableHead className="w-[150px] px-4 py-3 text-right">Amount</TableHead>
              <TableHead className="min-w-[220px] px-4 py-3">Commitment</TableHead>
              <TableHead className="w-[140px] px-4 py-3">Bill #</TableHead>
              <TableHead className="w-[96px] px-4 py-3 text-center">Receipt</TableHead>
              <TableHead className="min-w-[260px] px-4 py-3">Vendor link</TableHead>
              <TableHead className="min-w-[260px] px-4 py-3">QBO Account</TableHead>
              {costCodesEnabled ? <TableHead className="min-w-[220px] px-4 py-3">Cost Code</TableHead> : null}
              <TableHead className="sticky right-0 z-10 w-[112px] min-w-[112px] border-l bg-background px-3 py-3 text-center shadow-[-1px_0_0_hsl(var(--border))]">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((bill) => (
              <TableRow key={bill.id} data-state={selectedIds.includes(bill.id) ? "selected" : undefined} className="divide-x align-middle">
                <TableCell className="relative w-[72px] min-w-[72px] py-2 text-center align-middle">
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Checkbox checked={selectedIds.includes(bill.id)} onCheckedChange={(checked) => toggleSelectOne(bill.id, checked)} aria-label={`Select payable ${vendorLabel(bill)}`} />
                  </div>
                </TableCell>
                <TableCell className="px-4 py-2 cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-7 rounded-md">
                      <AvatarFallback className="rounded-md text-[11px] font-semibold">{initialsFor(vendorLabel(bill))}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{vendorLabel(bill)}</div>
                      {bill.company_name && bill.qbo_vendor_name && bill.company_name !== bill.qbo_vendor_name ? (
                        <div className="truncate text-[11px] text-muted-foreground">{bill.company_name}</div>
                      ) : null}
                    </div>
                    <span className="ml-auto flex shrink-0 items-center justify-center" title={statusLabel(bill.status)}>
                      <PayableStatusIcon status={bill.status} />
                    </span>
                  </div>
                </TableCell>
                <TableCell className="px-4 py-2 text-center text-sm tabular-nums text-muted-foreground cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>{bill.due_date ? format(new Date(`${bill.due_date}T00:00:00`), "MMM d, yyyy") : "—"}</TableCell>
                <TableCell className="px-4 py-2 text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>
                  <div className="text-sm font-semibold tabular-nums">{formatCurrency(bill.project_amount_cents ?? bill.total_cents ?? 0)}</div>
                  {bill.is_shared ? (
                    <div className="text-[10px] font-medium text-indigo-600 dark:text-indigo-400">of {formatCurrency(bill.total_cents ?? 0)} shared</div>
                  ) : null}
                </TableCell>
                <TableCell className="px-4 py-2">
                  <div className="max-w-[240px] truncate text-sm text-muted-foreground" title={bill.commitment_title}>
                    {bill.commitment_title ?? "No commitment"}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-2">
                  <code className="text-xs font-mono bg-muted px-1.5 py-0.5 uppercase tracking-wider">{bill.bill_number ?? "—"}</code>
                </TableCell>
                <TableCell className="px-4 py-2 text-center cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>
                  {bill.file_id ? (
                    <Button variant="ghost" size="icon" className="h-9 w-9" onClick={(e) => { e.stopPropagation(); onViewFiles?.(bill); }}>
                      <Receipt className="h-5 w-5 text-primary" />
                      <span className="sr-only">Preview receipt</span>
                    </Button>
                  ) : (
                    <span className="inline-flex h-9 w-9 items-center justify-center text-muted-foreground" aria-label="No receipt uploaded">
                      <Receipt className="h-5 w-5 opacity-40" />
                    </span>
                  )}
                </TableCell>
                <TableCell className="p-0">
                  <PayableVendorLinkCell bill={bill} onEditVendor={onEditVendor} />
                </TableCell>
                <TableCell className="p-0">
                  <PayableQboAccountCombobox
                    bill={bill}
                    accounts={qboExpenseAccounts}
                    open={openQboAccountBillId === bill.id}
                    onOpenChange={(open) => setOpenQboAccountBillId(open ? bill.id : null)}
                    onSelect={(accountId) => onSelectQboExpenseAccount?.(bill, accountId)}
                  />
                </TableCell>
                {costCodesEnabled ? (
                  <TableCell className="p-0">
                    <PayableCostCodeCombobox
                      bill={bill}
                      costCodes={costCodes}
                      open={openCostCodeBillId === bill.id}
                      onOpenChange={(open) => setOpenCostCodeBillId(open ? bill.id : null)}
                      onSelect={(costCodeId) => onSelectCostCode?.(bill, costCodeId)}
                    />
                  </TableCell>
                ) : null}
                <TableCell className="sticky right-0 z-10 w-[112px] min-w-[112px] border-l bg-background px-3 py-2 text-center shadow-[-1px_0_0_hsl(var(--border))]" onClick={(event) => event.stopPropagation()}>
                  <div className="flex items-center justify-center gap-2">
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      className={cn(
                        "h-9 w-9 rounded-md bg-background",
                        bill.status === "pending" ? "border-emerald-600 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700" : "border-muted text-muted-foreground opacity-70",
                      )}
                      disabled={bill.status !== "pending"}
                      onClick={() => onApprove?.(bill)}
                    >
                      <Check className="h-5 w-5" />
                      <span className="sr-only">Approve payable</span>
                    </Button>
                    <RowActions bill={bill} onEdit={onViewDetails} onViewFiles={onViewFiles} onSyncQbo={onSyncQbo} onDelete={onDelete} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={costCodesEnabled ? 11 : 10} className="h-48 text-center text-muted-foreground hover:bg-transparent">
                  <div className="flex flex-col items-center gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Receipt className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No payables found</p>
                      <p className="text-sm text-muted-foreground">Upload a bill or adjust the current filter.</p>
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      <div className="h-10 shrink-0 border-t bg-muted/10 px-4 flex items-center justify-between text-[11px] font-medium text-muted-foreground uppercase tracking-widest">
        <div>{filtered.length} records showing</div>
        <div className="flex gap-4">
          <span>Unpaid: {formatCurrency(vendorBills.reduce((sum, bill) => sum + ((bill.total_cents ?? 0) - (bill.paid_cents ?? 0)), 0))}</span>
          <span>Paid: {formatCurrency(vendorBills.reduce((sum, bill) => sum + (bill.paid_cents ?? 0), 0))}</span>
        </div>
      </div>
    </div>
  )
}

function PayableVendorLinkCell({
  bill,
  onEditVendor,
}: {
  bill: VendorBillSummary
  onEditVendor?: (bill: VendorBillSummary) => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left"
      onClick={() => onEditVendor?.(bill)}
      disabled={!bill.company_id}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-foreground">
          {bill.qbo_vendor_name ?? "Link vendor"}
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {bill.qbo_vendor_id ? "QuickBooks vendor linked" : "Needs QuickBooks vendor"}
        </span>
      </span>
      <Badge
        variant="outline"
        className={cn(
          "shrink-0 text-[10px] font-bold uppercase",
          bill.qbo_vendor_id
            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700"
            : "border-amber-500/20 bg-amber-500/10 text-amber-700",
        )}
      >
        {bill.qbo_vendor_id ? "Linked" : "Needed"}
      </Badge>
    </Button>
  )
}

function PayableQboAccountCombobox({
  bill,
  accounts,
  open,
  onOpenChange,
  onSelect,
}: {
  bill: VendorBillSummary
  accounts: QBOAccountOption[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (accountId: string) => void
}) {
  const selected = bill.qbo_expense_account_id ? accounts.find((account) => account.id === bill.qbo_expense_account_id) : null
  const selectedName = selected?.name ?? bill.qbo_expense_account_name?.split(":").pop()?.trim() ?? "Choose account"
  const selectedPath = selected?.fullyQualifiedName ?? bill.qbo_expense_account_name ?? "QuickBooks category"

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" role="combobox" aria-expanded={open} className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{selectedName}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{selectedPath}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[300px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search QBO accounts..." />
          <CommandList className="max-h-72 overflow-y-auto">
            <CommandEmpty>No accounts found.</CommandEmpty>
            <CommandGroup heading="Accounts">
              {accounts.map((account) => {
                const label = account.fullyQualifiedName ?? account.name
                const selectedAccount = account.id === bill.qbo_expense_account_id
                return (
                  <CommandItem key={account.id} value={label} onSelect={() => onSelect(account.id)}>
                    <Check className={cn("size-4", selectedAccount ? "opacity-100" : "opacity-0")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{account.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{label}</span>
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

function PayableCostCodeCombobox({
  bill,
  costCodes,
  open,
  onOpenChange,
  onSelect,
}: {
  bill: VendorBillSummary
  costCodes: CostCode[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (costCodeId: string | null) => void
}) {
  const selected = bill.actual_cost_code_id ? costCodes.find((code) => code.id === bill.actual_cost_code_id) : null
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" role="combobox" aria-expanded={open} className="h-full min-h-11 w-full justify-between gap-2 rounded-none px-3 py-2 text-left">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{selected?.code ?? bill.actual_cost_code_code ?? "Choose code"}</span>
            <span className="block truncate text-[11px] text-muted-foreground">{selected ? costCodeLabel(selected) : bill.actual_cost_code_name ?? "Project cost code"}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-[260px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search cost codes..." />
          <CommandList className="max-h-72 overflow-y-auto">
            <CommandEmpty>No cost codes found.</CommandEmpty>
            <CommandGroup heading="Cost codes">
              <CommandItem value="No cost code" onSelect={() => onSelect(null)}>
                <Check className={cn("size-4", bill.actual_cost_code_id ? "opacity-0" : "opacity-100")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">No cost code</span>
                  <span className="block truncate text-xs text-muted-foreground">Leave uncoded</span>
                </span>
              </CommandItem>
              {costCodes.map((code) => {
                const selectedCode = code.id === bill.actual_cost_code_id
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

function RowActions({
  bill,
  onEdit,
  onViewFiles,
  onSyncQbo,
  onDelete,
}: {
  bill: VendorBillSummary
  onEdit?: (bill: VendorBillSummary) => void
  onViewFiles?: (bill: VendorBillSummary) => void
  onSyncQbo?: (bill: VendorBillSummary) => void
  onDelete?: (bill: VendorBillSummary) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-9 w-9">
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Payable Actions</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onEdit?.(bill)}>Edit</DropdownMenuItem>
        <DropdownMenuItem onClick={() => onViewFiles?.(bill)}>View attachments</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => onSyncQbo?.(bill)} disabled={bill.qbo_sync_status === "synced"}>
          Sync to QuickBooks
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete?.(bill)}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete payable
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PayableStatusIcon({ status }: { status?: string }) {
  if (status === "paid" || status === "approved" || status === "partial") {
    return <CheckCircle2 className="h-4 w-4 text-success" />
  }
  return <Clock className="h-4 w-4 text-muted-foreground" />
}

function vendorLabel(bill: VendorBillSummary) {
  return bill.qbo_vendor_name ?? bill.company_name ?? "No vendor"
}

function statusLabel(status?: string) {
  if (status === "paid") return "Paid"
  if (status === "partial") return "Partially paid"
  if (status === "approved") return "Approved"
  return "Pending"
}

function initialsFor(value: string) {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  return (parts[0]?.[0] ?? "?").concat(parts[1]?.[0] ?? "").toUpperCase()
}

function costCodeLabel(code: CostCode) {
  return [code.code, code.name].filter(Boolean).join(" · ")
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}
