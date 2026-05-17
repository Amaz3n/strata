"use client"

import { type ReactNode, useMemo, useState } from "react"
import { format } from "date-fns"
import {
  MoreHorizontal,
  Plus,
  Search,
  FileText,
  Receipt, 
  CheckCircle2, 
  Clock,
  ExternalLink,
  Trash2,
  Filter,
  ShieldCheck,
  AlertTriangle
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuLabel, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"

interface PayablesExplorerProps {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  onAddPayable?: () => void
  onViewDetails?: (bill: VendorBillSummary) => void
  onApprove?: (bill: VendorBillSummary) => void
  onRecordPayment?: (bill: VendorBillSummary) => void
  onSyncQbo?: (bill: VendorBillSummary) => void
  onDelete?: (bill: VendorBillSummary) => void
  onViewFiles?: (bill: VendorBillSummary) => void
  toolbarLeading?: ReactNode
  fullBleed?: boolean
}

export function PayablesExplorer({
  projectId,
  vendorBills,
  costCodes,
  complianceRules,
  complianceStatusByCompanyId,
  onAddPayable,
  onViewDetails,
  onApprove,
  onRecordPayment,
  onSyncQbo,
  onDelete,
  onViewFiles,
  toolbarLeading,
  fullBleed = false,
}: PayablesExplorerProps) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

  function getPaymentGate(bill: VendorBillSummary) {
    const status = bill.company_id ? complianceStatusByCompanyId[bill.company_id] : null
    const missingCompliance = Boolean(complianceRules.block_payment_on_missing_docs && status && !status.is_compliant)
    const missingWaiver = Boolean(
      complianceRules.block_payment_on_missing_docs &&
        complianceRules.require_lien_waiver &&
        bill.lien_waiver_status !== "received",
    )

    if (missingCompliance || missingWaiver) {
      const reasons = [
        missingCompliance ? "Compliance docs" : null,
        missingWaiver ? "Lien waiver" : null,
      ].filter(Boolean)
      return {
        blocked: true,
        label: reasons.join(" + "),
      }
    }

    return {
      blocked: false,
      label: bill.status === "pending" ? "Needs approval" : "Clear",
    }
  }

  const filtered = useMemo(() => {
    return vendorBills.filter((bill) => {
      const matchesSearch = !search || 
        bill.company_name?.toLowerCase().includes(search.toLowerCase()) ||
        bill.bill_number?.toLowerCase().includes(search.toLowerCase()) ||
        bill.commitment_title?.toLowerCase().includes(search.toLowerCase())
      
      const matchesStatus = statusFilter === "all" || bill.status === statusFilter
      
      return matchesSearch && matchesStatus
    })
  }, [vendorBills, search, statusFilter])

  return (
    <div className={fullBleed ? "flex h-full w-full flex-col overflow-hidden bg-background" : "flex h-full flex-col overflow-hidden bg-background"}>
      <div
        className={
          fullBleed
            ? "sticky top-0 z-20 flex min-h-14 w-full flex-col border-b bg-background/95 shadow-[0_1px_0_rgba(0,0,0,0.02)] backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-stretch"
            : "flex min-h-14 shrink-0 flex-col border-b bg-background/95 backdrop-blur sm:flex-row sm:items-stretch"
        }
      >
        {toolbarLeading && (
          <div className="flex min-w-0 items-stretch px-4 sm:border-r sm:px-6 lg:px-8">{toolbarLeading}</div>
        )}
        <div
          className={
            toolbarLeading
              ? "flex w-full flex-col gap-2 px-4 py-3 sm:flex-1 sm:flex-row sm:items-center sm:justify-end sm:px-4 sm:py-2 lg:px-6"
              : "flex w-full flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-2 lg:px-8"
          }
        >
          <div className={toolbarLeading ? "w-full sm:max-w-sm lg:max-w-md xl:max-w-lg" : "w-full sm:max-w-xs"}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search payables"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-9 rounded-md bg-muted/30 pl-9 pr-12 shadow-none transition-colors focus-visible:bg-background"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 border-0 shadow-none hover:bg-background"
                  >
                    <Filter className="h-4 w-4" />
                    {statusFilter !== "all" && (
                      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary" />
                    )}
                    <span className="sr-only">Filters</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Filter by status</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={statusFilter === "all"} onCheckedChange={() => setStatusFilter("all")}>
                    Any status
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={statusFilter === "pending"} onCheckedChange={() => setStatusFilter("pending")}>
                    Pending
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={statusFilter === "approved"} onCheckedChange={() => setStatusFilter("approved")}>
                    Approved
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={statusFilter === "partial"} onCheckedChange={() => setStatusFilter("partial")}>
                    Partial
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem checked={statusFilter === "paid"} onCheckedChange={() => setStatusFilter("paid")}>
                    Paid
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          <div className="flex flex-row gap-2">
            <Button
              size={fullBleed ? "sm" : "default"}
              onClick={onAddPayable}
              className="h-9 flex-1 whitespace-nowrap sm:flex-none"
            >
              <Plus className="h-4 w-4 mr-2" />
              New payable
            </Button>
          </div>
        </div>
      </div>

      {/* Main Table Content */}
      <div className="flex-1 overflow-hidden">
        <ScrollArea className="h-full">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-muted/40 backdrop-blur-sm border-b shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
              <tr>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground w-12"></th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Company</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Commitment</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Bill #</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Due Date</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">QBO</th>
                <th className="px-4 py-3 text-left font-semibold text-muted-foreground">Payment Gate</th>
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">Amount</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-16">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-20 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <Receipt className="h-8 w-8 opacity-20" />
                      <p>No payables found</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((bill) => {
                  const paymentGate = getPaymentGate(bill)
                  return (
                    <tr
                      key={bill.id}
                      className="group hover:bg-muted/10 transition-colors cursor-pointer"
                      onClick={() => onViewDetails?.(bill)}
                    >
                    <td className="px-4 py-3 text-center">
                      <div className="h-8 w-8 rounded bg-muted/30 flex items-center justify-center text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                        <FileText className="h-4 w-4" />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-foreground group-hover:text-primary transition-colors">{bill.company_name ?? "—"}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-muted-foreground truncate max-w-[200px]" title={bill.commitment_title}>
                        {bill.commitment_title ?? "—"}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded uppercase tracking-wider">
                        {bill.bill_number ?? "—"}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 text-muted-foreground group-hover:text-foreground transition-colors">
                        <Clock className="h-3.5 w-3.5" />
                        <span>{bill.due_date ? format(new Date(bill.due_date), "MMM d, yyyy") : "—"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {billStatusBadge(bill.status)}
                    </td>
                    <td className="px-4 py-3">
                      {qboStatusBadge(bill.qbo_sync_status, bill.qbo_sync_error)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={
                          paymentGate.blocked
                            ? "border-destructive/30 bg-destructive/10 text-destructive"
                            : "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        }
                      >
                        {paymentGate.blocked ? (
                          <AlertTriangle className="mr-1 h-3 w-3" />
                        ) : (
                          <ShieldCheck className="mr-1 h-3 w-3" />
                        )}
                        {paymentGate.label}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="font-bold tabular-nums text-foreground group-hover:text-primary transition-colors">
                        {formatCurrency(bill.total_cents ?? 0)}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                            <MoreHorizontal className="h-4 w-4" />
                            <span className="sr-only">Actions</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56 shadow-xl">
                          <DropdownMenuLabel>Payable Actions</DropdownMenuLabel>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => onViewFiles?.(bill)}>
                            <ExternalLink className="mr-2 h-4 w-4 text-muted-foreground" />
                            View Attachments
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={() => onApprove?.(bill)}
                            disabled={bill.status === "approved" || bill.status === "paid" || bill.status === "partial"}
                          >
                            <CheckCircle2 className="mr-2 h-4 w-4 text-emerald-500" />
                            Approve for Payment
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => onRecordPayment?.(bill)}
                            disabled={(bill.status !== "approved" && bill.status !== "partial") || paymentGate.blocked}
                          >
                            <Receipt className="mr-2 h-4 w-4 text-blue-500" />
                            Record Payment
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onSyncQbo?.(bill)}
                            disabled={bill.status === "pending" || bill.qbo_sync_status === "pending"}
                          >
                            <ExternalLink className="mr-2 h-4 w-4 text-muted-foreground" />
                            Sync to QuickBooks
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => onDelete?.(bill)}>
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete Payable
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
        </ScrollArea>
      </div>
      
      {/* Mini Summary Footer */}
      <div className="h-10 shrink-0 border-t bg-muted/10 px-4 flex items-center justify-between text-[11px] font-medium text-muted-foreground uppercase tracking-widest">
        <div>{filtered.length} total records showing</div>
        <div className="flex gap-4">
          <span>Unpaid: {formatCurrency(vendorBills.reduce((sum, b) => sum + ((b.total_cents ?? 0) - (b.paid_cents ?? 0)), 0))}</span>
          <span className="text-emerald-600">Paid: {formatCurrency(vendorBills.reduce((sum, b) => sum + (b.paid_cents ?? 0), 0))}</span>
        </div>
      </div>
    </div>
  )
}

function billStatusBadge(status?: string) {
  const s = (status ?? "pending").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    paid: { label: "Paid", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    partial: { label: "Partial", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
    approved: { label: "Approved", tone: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20" },
    pending: { label: "Pending", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
  }
  const config = map[s] ?? map.pending
  return (
    <Badge variant="outline" className={cn("text-[10px] font-bold uppercase tracking-tight", config.tone)}>
      {config.label}
    </Badge>
  )
}

function qboStatusBadge(status?: string, error?: string) {
  const s = (status ?? "not_synced").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    synced: { label: "Synced", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    pending: { label: "Pending", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
    error: { label: "Error", tone: "bg-destructive/10 text-destructive border-destructive/20" },
    needs_review: { label: "Review", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
    skipped: { label: "Off", tone: "bg-muted text-muted-foreground border-border" },
    not_synced: { label: "Not synced", tone: "bg-muted text-muted-foreground border-border" },
  }
  const config = map[s] ?? map.not_synced
  return (
    <Badge variant="outline" title={error} className={cn("text-[10px] font-bold uppercase tracking-tight", config.tone)}>
      {config.label}
    </Badge>
  )
}

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { 
    style: "currency", 
    currency: "USD", 
    maximumFractionDigits: 0 
  })
}
