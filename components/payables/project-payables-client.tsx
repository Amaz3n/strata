"use client"

import { type ReactNode, useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"
import { 
  FileText, 
  Receipt, 
  CheckCircle2, 
  Plus, 
  Trash2, 
  ExternalLink,
  ChevronRight,
  Paperclip,
  Loader2
} from "lucide-react"

import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { ComplianceRules, ComplianceStatusSummary, CostCode } from "@/lib/types"
import {
  getPayablesAccountingContextAction,
  syncProjectVendorBillToQBOAction,
  updateProjectVendorBillStatusAction,
} from "@/app/(app)/projects/[id]/payables/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetDescription } from "@/components/ui/sheet"
import { Label } from "@/components/ui/label"
import { toast } from "sonner"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { listAttachmentsAction, detachFileLinkAction, uploadFileAction, attachFileAction } from "@/app/(app)/documents/actions"
import { PayablesExplorer } from "./payables-explorer"
import { AddPayableSheet } from "./add-payable-sheet"
import { QboSyncSheet } from "@/components/integrations/qbo-sync-sheet"

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function dollarsToCents(input: string) {
  const normalized = input.replaceAll(",", "").trim()
  if (!normalized) return 0
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

type QBOAccountOption = { id: string; name: string; account_type?: string; account_sub_type?: string }
type QBOVendorOption = { id: string; name: string }

function qboBillUrl(qboId?: string | null) {
  return qboId ? `https://qbo.intuit.com/app/bill?txnId=${encodeURIComponent(qboId)}` : null
}

function getPaymentBlockReason({
  bill,
  complianceRules,
  complianceStatusByCompanyId,
}: {
  bill: VendorBillSummary
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
}) {
  if (!complianceRules.block_payment_on_missing_docs) return null

  const reasons: string[] = []
  const complianceStatus = bill.company_id ? complianceStatusByCompanyId[bill.company_id] : null

  if (complianceStatus && !complianceStatus.is_compliant) {
    const missingCount =
      (complianceStatus.missing?.length ?? 0) +
      (complianceStatus.expired?.length ?? 0) +
      (complianceStatus.pending_review?.length ?? 0)
    reasons.push(missingCount > 0 ? `${missingCount} compliance item${missingCount === 1 ? "" : "s"}` : "Compliance")
  }

  if (complianceRules.require_lien_waiver && bill.lien_waiver_status !== "received") {
    reasons.push("Lien waiver")
  }

  return reasons.length > 0 ? reasons.join(" + ") : null
}

function billBadge(status?: string) {
  const normalized = (status ?? "pending").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    paid: { label: "Paid", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    partial: { label: "Partial", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
    approved: { label: "Approved", tone: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20" },
    pending: { label: "Pending", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
  }
  const config = map[normalized] ?? map.pending
  return (
    <Badge variant="outline" className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>
      {config.label}
    </Badge>
  )
}

function qboBadge(status?: string, error?: string) {
  const normalized = (status ?? "not_synced").toLowerCase()
  const map: Record<string, { label: string; tone: string }> = {
    synced: { label: "QBO synced", tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
    pending: { label: "QBO pending", tone: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
    error: { label: "QBO error", tone: "bg-destructive/10 text-destructive border-destructive/20" },
    needs_review: { label: "QBO review", tone: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
    skipped: { label: "QBO off", tone: "bg-muted text-muted-foreground border-border" },
    not_synced: { label: "Not synced", tone: "bg-muted text-muted-foreground border-border" },
  }
  const config = map[normalized] ?? map.not_synced
  return (
    <Badge variant="outline" title={error} className={`text-[10px] font-bold uppercase tracking-tight ${config.tone}`}>
      {config.label}
    </Badge>
  )
}

export function ProjectPayablesClient({
  projectId,
  vendorBills,
  costCodes,
  complianceRules,
  complianceStatusByCompanyId,
  toolbarLeading,
  fullBleed = false,
}: {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
  toolbarLeading?: ReactNode
  fullBleed?: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [addPayableOpen, setAddPayableOpen] = useState(false)
  const [syncSheetOpen, setSyncSheetOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState<Record<string, string>>({})
  const [paymentRef, setPaymentRef] = useState<Record<string, string>>({})
  const [paymentMethod, setPaymentMethod] = useState<Record<string, string>>({})
  const [billCostCode, setBillCostCode] = useState<Record<string, string>>({})
  const [accountingEnabled, setAccountingEnabled] = useState(false)
  const [qboExpenseAccounts, setQboExpenseAccounts] = useState<QBOAccountOption[]>([])
  const [qboApAccounts, setQboApAccounts] = useState<QBOAccountOption[]>([])
  const [qboVendors, setQboVendors] = useState<QBOVendorOption[]>([])
  const [qboDefaults, setQboDefaults] = useState<{ expenseAccountId?: string; apAccountId?: string }>({})

  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [selectedBill, setSelectedBill] = useState<VendorBillSummary | null>(null)
  const [billDetailOpen, setBillDetailOpen] = useState(false)
  const [detailRetainage, setDetailRetainage] = useState("")
  const [detailLienWaiver, setDetailLienWaiver] = useState("not_required")
  const [detailQboExpenseAccountId, setDetailQboExpenseAccountId] = useState("")
  const [detailQboApAccountId, setDetailQboApAccountId] = useState("")
  const [detailQboVendorId, setDetailQboVendorId] = useState("")
  const [detailActualLines, setDetailActualLines] = useState<
    Array<{ id: string; costCodeId: string; description: string; amountDollars: string; qboExpenseAccountId?: string }>
  >([])

  const selectedPaymentBlockReason = selectedBill
    ? getPaymentBlockReason({ bill: selectedBill, complianceRules, complianceStatusByCompanyId })
    : null

  const sortedCostCodes = useMemo(
    () => [...costCodes].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")),
    [costCodes],
  )

  const getExpenseAccountName = (accountId?: string) =>
    qboExpenseAccounts.find((account) => account.id === accountId)?.name

  const getApAccountName = (accountId?: string) =>
    qboApAccounts.find((account) => account.id === accountId)?.name

  const getVendorName = (vendorId?: string) => qboVendors.find((vendor) => vendor.id === vendorId)?.name

  useEffect(() => {
    let cancelled = false
    getPayablesAccountingContextAction()
      .then((context) => {
        if (cancelled) return
        setAccountingEnabled(Boolean(context.enabled))
        setQboExpenseAccounts(context.expenseAccounts ?? [])
        setQboApAccounts(context.apAccounts ?? [])
        setQboVendors(context.vendors ?? [])
        setQboDefaults(context.defaults ?? {})
      })
      .catch(() => {
        if (!cancelled) setAccountingEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const setStatus = (
    billId: string,
    status: "pending" | "approved" | "partial" | "paid",
    costCodeId?: string,
  ) => {
    startTransition(async () => {
      try {
        const amountInput = paymentAmount[billId]?.trim()
        const amountCents = amountInput ? Math.round(Number(amountInput) * 100) : undefined
        
        await updateProjectVendorBillStatusAction(projectId, billId, {
          status,
          cost_code_id: costCodeId ?? billCostCode[billId] ?? undefined,
          qbo_expense_account_id: qboDefaults.expenseAccountId,
          qbo_expense_account_name: getExpenseAccountName(qboDefaults.expenseAccountId),
          qbo_ap_account_id: qboDefaults.apAccountId,
          qbo_ap_account_name: getApAccountName(qboDefaults.apAccountId),
          payment_method: paymentMethod[billId] || undefined,
          payment_reference: paymentRef[billId] || undefined,
          payment_amount_cents: status === "paid" || status === "partial" ? amountCents : undefined,
        })
        toast.success("Bill updated successfully")
        router.refresh()
      } catch (error) {
        toast.error((error as Error).message)
      }
    })
  }

  // Load attachments whenever selectedBill changes
  useEffect(() => {
    if (!billDetailOpen || !selectedBill) {
      setAttachments([])
      return
    }
    
    setAttachmentsLoading(true)
    listAttachmentsAction("vendor_bill", selectedBill.id)
      .then((links) =>
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
        ),
      )
      .catch((error) => console.error("Failed to load vendor bill attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [billDetailOpen, selectedBill])

  useEffect(() => {
    if (!selectedBill) return
    setDetailRetainage(
      selectedBill.retainage_percent != null ? String(selectedBill.retainage_percent) : ""
    )
    setDetailLienWaiver(selectedBill.lien_waiver_status ?? "not_required")
    setDetailQboExpenseAccountId(selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "")
    setDetailQboApAccountId(selectedBill.qbo_ap_account_id ?? qboDefaults.apAccountId ?? "")
    setDetailQboVendorId(selectedBill.qbo_vendor_id ?? "")
    const existingLines = selectedBill.actual_lines ?? []
    setDetailActualLines(
      existingLines.length > 0
        ? existingLines.map((line) => ({
            id: line.id ?? crypto.randomUUID(),
            costCodeId: line.cost_code_id,
            description: line.description ?? selectedBill.bill_number ?? "Vendor bill",
            amountDollars: ((line.amount_cents ?? 0) / 100).toFixed(2),
            qboExpenseAccountId: line.qbo_expense_account_id ?? selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
          }))
        : [
            {
              id: crypto.randomUUID(),
              costCodeId: selectedBill.actual_cost_code_id ?? sortedCostCodes[0]?.id ?? "",
              description: selectedBill.bill_number ?? "Vendor bill",
              amountDollars: ((selectedBill.total_cents ?? 0) / 100).toFixed(2),
              qboExpenseAccountId: selectedBill.qbo_expense_account_id ?? qboDefaults.expenseAccountId ?? "",
            },
          ],
    )
  }, [selectedBill, sortedCostCodes, qboDefaults])

  const handleAttach = async (files: File[], linkRole?: string) => {
    if (!selectedBill) return
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("projectId", projectId)
      formData.append("category", "financials")

      const uploaded = await uploadFileAction(formData)
      await attachFileAction(uploaded.id, "vendor_bill", selectedBill.id, projectId, linkRole)
    }

    const links = await listAttachmentsAction("vendor_bill", selectedBill.id)
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

  const handleDetach = async (linkId: string) => {
    if (!selectedBill) return
    await detachFileLinkAction(linkId)
    const links = await listAttachmentsAction("vendor_bill", selectedBill.id)
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

  return (
    <div className={fullBleed ? "w-full" : "h-full flex flex-col"}>
      <div className={fullBleed ? "w-full" : "flex-1 overflow-hidden border rounded-xl bg-card shadow-sm"}>
        <PayablesExplorer
          projectId={projectId}
          vendorBills={vendorBills}
          costCodes={costCodes}
          qboVendors={qboVendors}
          complianceRules={complianceRules}
          complianceStatusByCompanyId={complianceStatusByCompanyId}
          toolbarLeading={toolbarLeading}
          fullBleed={fullBleed}
          onAddPayable={() => setAddPayableOpen(true)}
          onOpenSyncSheet={() => setSyncSheetOpen(true)}
          onSelectQboVendor={(bill, vendorId) => {
            startTransition(async () => {
              try {
                await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: bill.status as any,
                  qbo_vendor_id: vendorId || undefined,
                  qbo_vendor_name: getVendorName(vendorId),
                })
                toast.success("QBO vendor updated")
                router.refresh()
              } catch (error) {
                toast.error((error as Error).message)
              }
            })
          }}
          onSelectCostCode={(bill, costCodeId) => {
            startTransition(async () => {
              try {
                await updateProjectVendorBillStatusAction(projectId, bill.id, {
                  status: bill.status as any,
                  cost_code_id: costCodeId,
                  qbo_expense_account_id: bill.qbo_expense_account_id ?? qboDefaults.expenseAccountId,
                  qbo_expense_account_name: bill.qbo_expense_account_name ?? getExpenseAccountName(qboDefaults.expenseAccountId),
                })
                setBillCostCode((prev) => ({ ...prev, [bill.id]: costCodeId ?? "" }))
                toast.success("Cost code updated")
                router.refresh()
              } catch (error) {
                toast.error((error as Error).message)
              }
            })
          }}
          onViewDetails={(bill) => {
            setSelectedBill(bill)
            setBillDetailOpen(true)
          }}
          onViewFiles={(bill) => {
            setSelectedBill(bill)
            setBillDetailOpen(true) // Now opens the same sheet
          }}
          onApprove={(bill) => {
            setStatus(bill.id, "approved", bill.actual_cost_code_id)
          }}
          onRecordPayment={(bill) => {
            setSelectedBill(bill)
            setBillDetailOpen(true)
          }}
          onSyncQbo={(bill) => {
            startTransition(async () => {
              const result = await syncProjectVendorBillToQBOAction(projectId, bill.id)
              if (result.success) {
                toast.success("Synced to QuickBooks")
                router.refresh()
              } else {
                toast.error(result.error ?? "QuickBooks sync failed")
              }
            })
          }}
          onDelete={(bill) => {
            toast.info("Action restricted", { description: "Deletion must be handled by an administrator." })
          }}
        />
      </div>

      <AddPayableSheet
        projectId={projectId}
        open={addPayableOpen}
        onOpenChange={setAddPayableOpen}
        onSuccess={() => router.refresh()}
      />

      <QboSyncSheet open={syncSheetOpen} onOpenChange={setSyncSheetOpen} projectId={projectId} />

      {/* Unified Bill Details Sheet */}
      <Sheet 
        open={billDetailOpen} 
        onOpenChange={(open) => {
          setBillDetailOpen(open)
          if (!open) setSelectedBill(null)
        }}
      >
        <SheetContent side="right" className="sm:max-w-xl w-full flex flex-col p-0 shadow-2xl border-l">
          {selectedBill && (
            <>
              <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
                <SheetTitle className="flex items-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  {selectedBill.bill_number ? `Bill ${selectedBill.bill_number}` : "Bill Details"}
                </SheetTitle>
                <SheetDescription>
                  {selectedBill.company_name} • {selectedBill.commitment_title}
                </SheetDescription>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-6 py-6 space-y-8">
                {/* Status Hero */}
                <div className="flex items-center justify-between p-5 rounded-xl border bg-muted/5 shadow-inner">
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Current Status</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {billBadge(selectedBill.status)}
                      {qboBadge(selectedBill.qbo_sync_status, selectedBill.qbo_sync_error)}
                    </div>
                    {selectedBill.qbo_id && (
                      <a
                        href={qboBillUrl(selectedBill.qbo_id) ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        Open in QuickBooks
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                  <div className="text-right space-y-1">
                    <p className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Total Amount</p>
                    <p className="text-3xl font-bold tabular-nums tracking-tight">{formatMoneyFromCents(selectedBill.total_cents)}</p>
                  </div>
                </div>

                {/* Attachments Section (NEW - Integrated) */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground flex items-center gap-2">
                      <Paperclip className="h-3.5 w-3.5" />
                      Documents & Invoices
                    </h4>
                    {attachmentsLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                  </div>
                  
                  <div className="rounded-xl border bg-muted/5 p-4 shadow-inner">
                    <EntityAttachments
                      entityType="vendor_bill"
                      entityId={selectedBill.id}
                      projectId={projectId}
                      attachments={attachments}
                      onAttach={handleAttach}
                      onDetach={handleDetach}
                      readOnly={attachmentsLoading}
                      compact
                    />
                  </div>
                </div>

                {/* Main Details Grid */}
                <div className="grid grid-cols-2 gap-x-8 gap-y-6 pt-4 border-t">
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Bill Date</Label>
                    <p className="text-sm font-semibold">{selectedBill.bill_date ? format(new Date(selectedBill.bill_date), "PPP") : "—"}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Due Date</Label>
                    <p className="text-sm font-semibold">{selectedBill.due_date ? format(new Date(selectedBill.due_date), "PPP") : "—"}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Amount Paid</Label>
                    <p className="text-sm font-semibold text-emerald-600">{formatMoneyFromCents(selectedBill.paid_cents)}</p>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Balance Remaining</Label>
                    <p className="text-sm font-semibold text-amber-600">
                      {formatMoneyFromCents(Math.max(0, (selectedBill.total_cents ?? 0) - (selectedBill.paid_cents ?? 0)))}
                    </p>
                  </div>
                </div>

                {/* Quick Actions for Pending/Approved */}
                {(selectedBill.status === "pending" || selectedBill.status === "approved" || selectedBill.status === "partial") && (
                  <div className="space-y-4 pt-6 border-t">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Workflow Actions</h4>
                    <div className="flex flex-col gap-4">
                      {selectedBill.status === "pending" && (
                        <Button 
                          className="w-full h-11 shadow-sm justify-between group" 
                          variant="outline"
                          onClick={() => setStatus(selectedBill.id, "approved", selectedBill.actual_cost_code_id)}
                          disabled={isPending}
                        >
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                            <span>Approve for Payment</span>
                          </div>
                          <ChevronRight className="h-4 w-4 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
                        </Button>
                      )}
                      {(selectedBill.status === "approved" || selectedBill.status === "partial") && (
                        <div className="w-full space-y-4 p-5 rounded-xl border bg-blue-50/30 dark:bg-blue-900/10 border-blue-100 dark:border-blue-900/30 shadow-sm">
                          <div className="flex items-center gap-2 text-blue-700 dark:text-blue-400 font-bold text-xs uppercase tracking-wider">
                            <Receipt className="h-3.5 w-3.5" />
                            Record Payment
                          </div>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                              <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Amount</Label>
                              <div className="relative">
                                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                                  <span className="text-muted-foreground text-xs">$</span>
                                </div>
                                <Input
                                  className="pl-7 h-10 font-semibold"
                                  placeholder="0.00"
                                  value={paymentAmount[selectedBill.id] ?? ""}
                                  onChange={(e) => setPaymentAmount(prev => ({ ...prev, [selectedBill.id]: e.target.value }))}
                                />
                              </div>
                            </div>
                            <div className="space-y-2">
                              <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Method</Label>
                              <Select
                                value={paymentMethod[selectedBill.id] ?? selectedBill.payment_method ?? "check"}
                                onValueChange={(v) => setPaymentMethod(prev => ({ ...prev, [selectedBill.id]: v }))}
                              >
                                <SelectTrigger className="h-10 w-full">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="check">Check</SelectItem>
                                  <SelectItem value="ach">ACH</SelectItem>
                                  <SelectItem value="wire">Wire</SelectItem>
                                  <SelectItem value="card">Card</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          </div>
                          <div className="space-y-2">
                            <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Reference / Confirmation #</Label>
                            <Input
                              className="h-10"
                              placeholder="Check # or Transaction ID"
                              value={paymentRef[selectedBill.id] ?? selectedBill.payment_reference ?? ""}
                              onChange={(e) => setPaymentRef(prev => ({ ...prev, [selectedBill.id]: e.target.value }))}
                            />
                          </div>
                          <Button 
                            className="w-full h-10 shadow-md bg-blue-600 hover:bg-blue-700" 
                            disabled={isPending || Boolean(selectedPaymentBlockReason)}
                            onClick={() => setStatus(selectedBill.id, "paid")}
                          >
                            {isPending ? "Processing..." : selectedPaymentBlockReason ? `Blocked: ${selectedPaymentBlockReason}` : "Post Payment"}
                          </Button>
                          {selectedPaymentBlockReason && (
                            <p className="text-xs font-medium text-destructive">
                              Payment cannot be posted until {selectedPaymentBlockReason.toLowerCase()} is cleared.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Cost Coding Split section */}
                <div className="space-y-4 pt-6 border-t">
                  <div className="flex items-center justify-between">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Actual Cost Coding</h4>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs shadow-sm"
                      onClick={() =>
                        setDetailActualLines((prev) => [
                          ...prev,
                          {
                            id: crypto.randomUUID(),
                            costCodeId: sortedCostCodes[0]?.id ?? "",
                            description: selectedBill.bill_number ?? "Vendor bill",
                            amountDollars: "0.00",
                            qboExpenseAccountId: detailQboExpenseAccountId,
                          },
                        ])
                      }
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Add Split
                    </Button>
                  </div>
                  
                  <div className="space-y-4">
                    {detailActualLines.map((line, index) => (
                      <div key={line.id} className="flex flex-col gap-3 p-4 rounded-xl border bg-background shadow-sm">
                        <div className="flex items-center gap-3">
                          <div className="flex-1">
                            <Select
                              value={line.costCodeId}
                              onValueChange={(value) =>
                                setDetailActualLines((prev) =>
                                  prev.map((item) => (item.id === line.id ? { ...item, costCodeId: value } : item)),
                                )
                              }
                            >
                              <SelectTrigger className="h-9 text-xs w-full">
                                <SelectValue placeholder="Select cost code" />
                              </SelectTrigger>
                              <SelectContent>
                                {sortedCostCodes.map((code) => (
                                  <SelectItem key={code.id} value={code.id} className="text-xs">
                                    {code.code ? `${code.code} - ${code.name}` : code.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="relative w-36 shrink-0">
                            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
                              <span className="text-muted-foreground text-[10px] font-bold">$</span>
                            </div>
                            <Input
                              value={line.amountDollars}
                              onChange={(event) =>
                                setDetailActualLines((prev) =>
                                  prev.map((item) => (item.id === line.id ? { ...item, amountDollars: event.target.value } : item)),
                                )
                              }
                              inputMode="decimal"
                              className="h-9 pl-7 text-right tabular-nums text-xs font-semibold"
                            />
                          </div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 text-muted-foreground hover:text-destructive hover:bg-destructive/5"
                            disabled={detailActualLines.length === 1}
                            onClick={() => setDetailActualLines((prev) => prev.filter((item) => item.id !== line.id))}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                        <Input
                          value={line.description}
                          onChange={(event) =>
                            setDetailActualLines((prev) =>
                              prev.map((item) => (item.id === line.id ? { ...item, description: event.target.value } : item)),
                            )
                          }
                          placeholder="Split description..."
                          className="h-8 text-xs bg-muted/20 border-dashed"
                        />
                      </div>
                    ))}
                  </div>

                  {accountingEnabled && (
                    <div className="space-y-4 rounded-xl border bg-muted/5 p-4">
                      <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">QuickBooks Coding</h4>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2 sm:col-span-2">
                          <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">QBO Vendor</Label>
                          <Select value={detailQboVendorId} onValueChange={setDetailQboVendorId}>
                            <SelectTrigger className="h-10 w-full">
                              <SelectValue placeholder={selectedBill.company_name ?? "Match vendor"} />
                            </SelectTrigger>
                            <SelectContent>
                              {qboVendors.map((vendor) => (
                                <SelectItem key={vendor.id} value={vendor.id}>
                                  {vendor.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Category / Account</Label>
                          <Select
                            value={detailQboExpenseAccountId}
                            onValueChange={(value) => {
                              setDetailQboExpenseAccountId(value)
                              setDetailActualLines((prev) =>
                                prev.map((line) => ({ ...line, qboExpenseAccountId: line.qboExpenseAccountId || value })),
                              )
                            }}
                          >
                            <SelectTrigger className="h-10 w-full">
                              <SelectValue placeholder="Select QBO account" />
                            </SelectTrigger>
                            <SelectContent>
                              {qboExpenseAccounts.map((account) => (
                                <SelectItem key={account.id} value={account.id}>
                                  {account.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">AP Account</Label>
                          <Select value={detailQboApAccountId} onValueChange={setDetailQboApAccountId}>
                            <SelectTrigger className="h-10 w-full">
                              <SelectValue placeholder="Default AP account" />
                            </SelectTrigger>
                            <SelectContent>
                              {qboApAccounts.map((account) => (
                                <SelectItem key={account.id} value={account.id}>
                                  {account.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Financial Meta terms */}
                  <div className="grid grid-cols-2 gap-6 pt-4">
                    <div className="space-y-2">
                      <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Retainage %</Label>
                      <div className="relative">
                        <Input
                          type="number"
                          step="0.1"
                          value={detailRetainage}
                          onChange={(e) => setDetailRetainage(e.target.value)}
                          placeholder="0"
                          className="h-10 pr-8 font-semibold"
                        />
                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3">
                          <span className="text-muted-foreground text-xs">%</span>
                        </div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-[10px] uppercase font-bold text-muted-foreground tracking-widest">Lien Waiver</Label>
                      <Select value={detailLienWaiver} onValueChange={setDetailLienWaiver}>
                        <SelectTrigger className="h-10 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="not_required">Not required</SelectItem>
                          <SelectItem value="requested">Requested</SelectItem>
                          <SelectItem value="received">Received</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>

              <SheetFooter className="p-6 border-t bg-muted/10 grid grid-cols-2 gap-4">
                <Button variant="outline" className="h-11" onClick={() => setBillDetailOpen(false)}>Cancel</Button>
                <Button
                  className="h-11 shadow-lg"
                  disabled={isPending}
                  onClick={() => {
                    const retainagePercent = detailRetainage.trim() ? Number(detailRetainage) : undefined
                    if (detailRetainage.trim()) {
                      if (retainagePercent === undefined || !Number.isFinite(retainagePercent) || retainagePercent < 0) {
                        toast.error("Invalid retainage percentage")
                        return
                      }
                    }
                    startTransition(async () => {
                      try {
                        const actualLines = detailActualLines.map((line) => ({
                          cost_code_id: line.costCodeId,
                          description: line.description.trim() || selectedBill.bill_number || "Vendor bill",
                          amount_cents: dollarsToCents(line.amountDollars) ?? -1,
                          qbo_expense_account_id: line.qboExpenseAccountId || detailQboExpenseAccountId || undefined,
                          qbo_expense_account_name: getExpenseAccountName(line.qboExpenseAccountId || detailQboExpenseAccountId),
                        }))
                        if (actualLines.some((line) => !line.cost_code_id || line.amount_cents < 0)) {
                          toast.error("Invalid cost coding. Each split needs a cost code and amount.")
                          return
                        }
                        const actualTotal = actualLines.reduce((sum, line) => sum + line.amount_cents, 0)
                        if (actualTotal !== (selectedBill.total_cents ?? 0)) {
                          toast.error(`Coding total (${formatMoneyFromCents(actualTotal)}) must match bill total (${formatMoneyFromCents(selectedBill.total_cents)})`)
                          return
                        }

                        await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
                          status: selectedBill.status as any,
                          actual_lines: actualLines,
                          retainage_percent: retainagePercent,
                          lien_waiver_status: detailLienWaiver as any,
                          qbo_expense_account_id: detailQboExpenseAccountId || undefined,
                          qbo_expense_account_name: getExpenseAccountName(detailQboExpenseAccountId),
                          qbo_ap_account_id: detailQboApAccountId || undefined,
                          qbo_ap_account_name: getApAccountName(detailQboApAccountId),
                          qbo_vendor_id: detailQboVendorId || undefined,
                          qbo_vendor_name: getVendorName(detailQboVendorId),
                        })
                        setBillCostCode((prev) => ({
                          ...prev,
                          [selectedBill.id]: actualLines[0]?.cost_code_id ?? "",
                        }))
                        toast.success("AP details updated")
                        router.refresh()
                        setBillDetailOpen(false)
                      } catch (error: any) {
                        toast.error(error?.message ?? "Failed to update details")
                      }
                    })
                  }}
                >
                  Save Changes
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
