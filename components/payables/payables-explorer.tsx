"use client"

import { type ReactNode, useMemo, useState } from "react"
import {
  Check,
  CheckCircle2,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { isVendorCredit, summarizePayables } from "@/lib/financials/payables-rules"
import type { ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import { CodingCombobox } from "@/components/financials/workspace/coding-combobox"
import { filterPayables, payableQueueCounts, type PayableQueue } from "./payables-filters"
import { billBadge, dueDateClassName, getDueState, payableTypeBadge, vendorLabel } from "./payables-ui"

type QBOAccountOption = { id: string; name: string; fullyQualifiedName?: string }

interface PayablesExplorerProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  costCodesEnabled?: boolean
  accountingEnabled?: boolean
  qboExpenseAccounts?: QBOAccountOption[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  onAddPayable?: () => void
  onViewDetails?: (bill: VendorBillSummary) => void
  onApprove?: (bill: VendorBillSummary) => void
  onSyncQbo?: (bill: VendorBillSummary) => void
  onOpenSyncSheet?: () => void
  onDelete?: (bill: VendorBillSummary) => void
  onBulkApprove?: (bills: VendorBillSummary[]) => void
  onBulkSyncQbo?: (bills: VendorBillSummary[]) => void
  onSelectCostCode?: (bill: VendorBillSummary, costCodeId: string | null) => void
  onSelectQboExpenseAccount?: (bill: VendorBillSummary, accountId: string) => void
  toolbarLeading?: ReactNode
  fullBleed?: boolean
}

export function PayablesExplorer({
  vendorBills,
  costCodes,
  costCodesEnabled = true,
  accountingEnabled = true,
  qboExpenseAccounts = [],
  complianceRules,
  complianceStatusByCompanyId,
  onAddPayable,
  onViewDetails,
  onApprove,
  onSyncQbo,
  onOpenSyncSheet,
  onDelete,
  onBulkApprove,
  onBulkSyncQbo,
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
    () => filterPayables(vendorBills, { search, queue: queueFilter, costCodesEnabled, accountingEnabled }),
    [accountingEnabled, costCodesEnabled, vendorBills, search, queueFilter],
  )

  const filterCounts = useMemo(
    () => payableQueueCounts(vendorBills, costCodesEnabled, accountingEnabled),
    [accountingEnabled, costCodesEnabled, vendorBills],
  )
  const totals = useMemo(() => summarizePayables(vendorBills), [vendorBills])
  const selectedBills = useMemo(
    () => vendorBills.filter((bill) => selectedIds.includes(bill.id)),
    [selectedIds, vendorBills],
  )
  const bulkApprovable = selectedBills.filter((bill) => bill.status === "pending" && !isVendorCredit(bill))
  const bulkSyncable = selectedBills.filter((bill) => bill.qbo_sync_status !== "synced" && !isVendorCredit(bill))

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
              { key: "overdue", label: "Overdue" },
              { key: "due_soon", label: "Due soon" },
              { key: "needs_review", label: "Needs review" },
              { key: "ready", label: accountingEnabled ? "Ready to sync" : "Ready to pay" },
              { key: "synced", label: accountingEnabled ? "Synced" : "Paid" },
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
          {accountingEnabled ? (
            <Button type="button" variant="outline" onClick={onOpenSyncSheet} className="w-full sm:w-auto">
              <ExternalLink className="mr-2 h-4 w-4" />
              QuickBooks
            </Button>
          ) : null}
          <Button type="button" onClick={onAddPayable} className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            New payable
          </Button>
        </div>
      </div>

      {selectedBills.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-2 text-sm">
          <span className="font-medium">{selectedBills.length} selected</span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bulkApprovable.length === 0}
              onClick={() => {
                onBulkApprove?.(bulkApprovable)
                setSelectedIds([])
              }}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Approve {bulkApprovable.length || ""}
            </Button>
            {accountingEnabled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={bulkSyncable.length === 0}
                onClick={() => {
                  onBulkSyncQbo?.(bulkSyncable)
                  setSelectedIds([])
                }}
              >
                <ExternalLink className="mr-2 h-4 w-4" />
                Sync {bulkSyncable.length || ""}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedIds([])}>
              Clear
            </Button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto">
        <Table className={costCodesEnabled ? "min-w-[1260px]" : "min-w-[1100px]"}>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="relative w-[72px] min-w-[72px] py-3 text-center">
                <div className="absolute inset-0 flex items-center justify-center">
                  <Checkbox checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false} onCheckedChange={toggleSelectAll} aria-label="Select all payables" />
                </div>
              </TableHead>
              <TableHead className="min-w-[280px] px-4 py-3">Vendor / Bill</TableHead>
              <TableHead className="w-[120px] px-4 py-3 text-center">Status</TableHead>
              <TableHead className="w-[132px] px-4 py-3 text-center">Due Date</TableHead>
              <TableHead className="w-[150px] px-4 py-3 text-right">Amount</TableHead>
              <TableHead className="min-w-[220px] px-4 py-3">Commitment</TableHead>
              {accountingEnabled ? <TableHead className="min-w-[260px] px-4 py-3">Vendor link</TableHead> : null}
              {accountingEnabled ? <TableHead className="min-w-[260px] px-4 py-3">QBO Account</TableHead> : null}
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
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold">{vendorLabel(bill)}</span>
                        {bill.file_id ? <Receipt className="h-3.5 w-3.5 shrink-0 text-primary" /> : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {bill.bill_number ? `Bill #${bill.bill_number}` : "No bill number"}
                        {bill.company_name && bill.qbo_vendor_name && bill.company_name !== bill.qbo_vendor_name ? ` • ${bill.company_name}` : ""}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="px-4 py-2 text-center cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>
                  <div className="flex items-center justify-center gap-1.5">
                    {isVendorCredit(bill) ? payableTypeBadge(bill) : billBadge(bill.status)}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-2 text-center text-sm cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>
                  <span className={dueDateClassName(bill.due_date, bill.status)}>
                    {bill.due_date ? getDueState(bill.due_date, bill.status).label : "—"}
                  </span>
                </TableCell>
                <TableCell className="px-4 py-2 text-right cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => onViewDetails?.(bill)}>
                  <div className="text-sm font-semibold tabular-nums">{formatCurrency(bill.project_amount_cents ?? bill.total_cents ?? 0)}</div>
                  {bill.is_shared ? (
                    <div className="text-[10px] font-medium text-primary">of {formatCurrency(bill.total_cents ?? 0)} shared</div>
                  ) : null}
                </TableCell>
                <TableCell className="px-4 py-2">
                  <div className="max-w-[240px] truncate text-sm text-muted-foreground" title={bill.commitment_title}>
                    {bill.commitment_title ?? "No commitment"}
                  </div>
                  {bill.over_budget ? (
                    <div className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-destructive">Over commitment</div>
                  ) : null}
                </TableCell>
                {accountingEnabled ? (
                  <TableCell className="p-0">
                    <PayableVendorLinkCell bill={bill} onEditVendor={onViewDetails} />
                  </TableCell>
                ) : null}
                {accountingEnabled ? (
                  <TableCell className="p-0">
                    <PayableQboAccountCombobox
                      bill={bill}
                      accounts={qboExpenseAccounts}
                      open={openQboAccountBillId === bill.id}
                      onOpenChange={(open) => setOpenQboAccountBillId(open ? bill.id : null)}
                      onSelect={(accountId) => onSelectQboExpenseAccount?.(bill, accountId)}
                    />
                  </TableCell>
                ) : null}
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
                        bill.status === "pending" ? "border-success text-success hover:bg-success/10" : "border-muted text-muted-foreground opacity-70",
                      )}
                      disabled={bill.status !== "pending" || isVendorCredit(bill)}
                      onClick={() => onApprove?.(bill)}
                    >
                      <Check className="h-5 w-5" />
                      <span className="sr-only">Approve payable</span>
                    </Button>
                    <RowActions
                      bill={bill}
                      accountingEnabled={accountingEnabled}
                      onEdit={onViewDetails}
                      onViewFiles={onViewDetails}
                      onSyncQbo={onSyncQbo}
                      onDelete={onDelete}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={(costCodesEnabled ? 8 : 7) + (accountingEnabled ? 2 : 0)} className="h-48 text-center text-muted-foreground hover:bg-transparent">
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
          <span>Outstanding: {formatCurrency(totals.outstandingCents)}</span>
          <span>Settled: {formatCurrency(totals.settledCents)}</span>
          <span>Vendor credits: {formatCurrency(totals.vendorCreditsCents)}</span>
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
            ? "border-success/20 bg-success/10 text-success"
            : "border-warning/20 bg-warning/10 text-warning",
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
    <CodingCombobox
      open={open}
      onOpenChange={onOpenChange}
      triggerLabel={selectedName}
      triggerSublabel={selectedPath}
      searchPlaceholder="Search QBO accounts..."
      groupHeading="Accounts"
      emptyLabel="No accounts found."
      options={accounts.map((account) => ({
        id: account.id,
        label: account.name,
        sublabel: account.fullyQualifiedName ?? account.name,
        searchValue: account.fullyQualifiedName ?? account.name,
      }))}
      selectedId={bill.qbo_expense_account_id ?? null}
      onSelect={(accountId) => accountId && onSelect(accountId)}
      contentMinWidthClass="min-w-[300px]"
    />
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
    <CodingCombobox
      open={open}
      onOpenChange={onOpenChange}
      triggerLabel={selected?.code ?? bill.actual_cost_code_code ?? "Choose code"}
      triggerSublabel={selected ? costCodeLabel(selected) : bill.actual_cost_code_name ?? "Project cost code"}
      searchPlaceholder="Search cost codes..."
      groupHeading="Cost codes"
      emptyLabel="No cost codes found."
      options={costCodes.map((code) => ({ id: code.id, label: code.code ?? costCodeLabel(code), sublabel: costCodeLabel(code), searchValue: costCodeLabel(code) }))}
      selectedId={bill.actual_cost_code_id ?? null}
      clearOption={{ label: "No cost code", sublabel: "Leave uncoded" }}
      onSelect={onSelect}
      contentMinWidthClass="min-w-[260px]"
    />
  )
}

function RowActions({
  bill,
  accountingEnabled,
  onEdit,
  onViewFiles,
  onSyncQbo,
  onDelete,
}: {
  bill: VendorBillSummary
  accountingEnabled: boolean
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
        {accountingEnabled ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onSyncQbo?.(bill)} disabled={bill.qbo_sync_status === "synced" || isVendorCredit(bill)}>
              Sync to QuickBooks
            </DropdownMenuItem>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete?.(bill)}>
          <Trash2 className="mr-2 h-4 w-4" />
          Delete payable
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
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
