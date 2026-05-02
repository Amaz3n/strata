"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
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
import { updateProjectVendorBillStatusAction } from "@/app/(app)/projects/[id]/payables/actions"

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

export function ProjectPayablesClient({
  projectId,
  vendorBills,
  costCodes,
  complianceRules,
  complianceStatusByCompanyId,
}: {
  projectId: string
  vendorBills: VendorBillSummary[]
  costCodes: CostCode[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [addPayableOpen, setAddPayableOpen] = useState(false)
  const [paymentAmount, setPaymentAmount] = useState<Record<string, string>>({})
  const [paymentRef, setPaymentRef] = useState<Record<string, string>>({})
  const [paymentMethod, setPaymentMethod] = useState<Record<string, string>>({})
  const [billCostCode, setBillCostCode] = useState<Record<string, string>>({})

  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [selectedBill, setSelectedBill] = useState<VendorBillSummary | null>(null)
  const [billDetailOpen, setBillDetailOpen] = useState(false)
  const [detailRetainage, setDetailRetainage] = useState("")
  const [detailLienWaiver, setDetailLienWaiver] = useState("not_required")
  const [detailActualLines, setDetailActualLines] = useState<
    Array<{ id: string; costCodeId: string; description: string; amountDollars: string }>
  >([])

  const sortedCostCodes = useMemo(
    () => [...costCodes].sort((a, b) => (a.code ?? "").localeCompare(b.code ?? "")),
    [costCodes],
  )

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
    const existingLines = selectedBill.actual_lines ?? []
    setDetailActualLines(
      existingLines.length > 0
        ? existingLines.map((line) => ({
            id: line.id ?? crypto.randomUUID(),
            costCodeId: line.cost_code_id,
            description: line.description ?? selectedBill.bill_number ?? "Vendor bill",
            amountDollars: ((line.amount_cents ?? 0) / 100).toFixed(2),
          }))
        : [
            {
              id: crypto.randomUUID(),
              costCodeId: selectedBill.actual_cost_code_id ?? sortedCostCodes[0]?.id ?? "",
              description: selectedBill.bill_number ?? "Vendor bill",
              amountDollars: ((selectedBill.total_cents ?? 0) / 100).toFixed(2),
            },
          ],
    )
  }, [selectedBill, sortedCostCodes])

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
    <div className="h-full flex flex-col">
      <div className="flex-1 overflow-hidden border rounded-xl bg-card shadow-sm">
        <PayablesExplorer
          projectId={projectId}
          vendorBills={vendorBills}
          costCodes={costCodes}
          complianceRules={complianceRules}
          complianceStatusByCompanyId={complianceStatusByCompanyId}
          onAddPayable={() => setAddPayableOpen(true)}
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
                    <div className="mt-1">{billBadge(selectedBill.status)}</div>
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
                            disabled={isPending}
                            onClick={() => setStatus(selectedBill.id, "paid")}
                          >
                            {isPending ? "Processing..." : "Post Payment"}
                          </Button>
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
