"use client"

import { useMemo, useState } from "react"
import { format } from "date-fns"
import { 
  MoreHorizontal, 
  Plus, 
  Search, 
  X, 
  FileText, 
  Receipt, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  ExternalLink,
  Trash2,
  Filter
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
  onDelete?: (bill: VendorBillSummary) => void
  onViewFiles?: (bill: VendorBillSummary) => void
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
  onDelete,
  onViewFiles,
}: PayablesExplorerProps) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<string>("all")

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
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Toolbar - mirroring documents toolbar */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b px-4 bg-muted/20">
        <div className="flex items-center gap-4">
          <div className="relative w-72">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search payables..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-9 pl-9 bg-background shadow-none border-muted-foreground/20 focus-visible:ring-1"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9 gap-2 shadow-sm">
                <Filter className="h-3.5 w-3.5" />
                <span>Status</span>
                {statusFilter !== "all" && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] bg-primary/10 text-primary border-none">
                    1
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuLabel>Filter by Status</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem checked={statusFilter === "all"} onCheckedChange={() => setStatusFilter("all")}>
                All Statuses
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

        <div className="flex items-center gap-2">
          <Button size="sm" onClick={onAddPayable} className="h-9 shadow-sm">
            <Plus className="h-4 w-4 mr-2" />
            Add Payable
          </Button>
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
                <th className="px-4 py-3 text-right font-semibold text-muted-foreground">Amount</th>
                <th className="px-4 py-3 text-center font-semibold text-muted-foreground w-16">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-20 text-center text-muted-foreground">
                    <div className="flex flex-col items-center gap-2">
                      <Receipt className="h-8 w-8 opacity-20" />
                      <p>No payables found</p>
                    </div>
                  </td>
                </tr>
              ) : (
                filtered.map((bill) => (
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
                            disabled={bill.status !== "approved" && bill.status !== "partial"}
                          >
                            <Receipt className="mr-2 h-4 w-4 text-blue-500" />
                            Record Payment
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
                ))
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

function formatCurrency(cents: number) {
  return (cents / 100).toLocaleString("en-US", { 
    style: "currency", 
    currency: "USD", 
    maximumFractionDigits: 0 
  })
}
