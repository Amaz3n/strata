"use client"

import { useEffect, useMemo, useState, useTransition } from "react"

import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import type { ComplianceRules, ComplianceStatusSummary } from "@/lib/types"
import { updateProjectVendorBillStatusAction } from "@/app/(app)/projects/[id]/payables/actions"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { listAttachmentsAction, detachFileLinkAction, uploadFileAction, attachFileAction } from "@/app/(app)/files/actions"

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function billBadge(status?: string) {
  const normalized = (status ?? "pending").toLowerCase()
  if (normalized === "paid") return <Badge variant="secondary">Paid</Badge>
  if (normalized === "partial") return <Badge variant="outline">Partial</Badge>
  if (normalized === "approved") return <Badge variant="outline">Approved</Badge>
  return <Badge variant="outline">Pending</Badge>
}

function complianceWarnings(
  bill: VendorBillSummary,
  rules: ComplianceRules,
  status?: ComplianceStatusSummary
) {
  const warnings: string[] = []

  // Compliance is driven by company-specific requirements + uploaded docs.
  if (status) {
    if (status.missing.length > 0) warnings.push(`${status.missing.length} missing required doc(s)`)
    if (status.expired.length > 0) warnings.push(`${status.expired.length} expired doc(s)`)
    if (status.deficiencies.length > 0) warnings.push(`${status.deficiencies.length} doc(s) need updates`)
    if (status.pending_review.length > 0) warnings.push(`${status.pending_review.length} pending review`)
    if (status.expiring_soon.length > 0) warnings.push(`${status.expiring_soon.length} expiring soon`)
  }

  if (rules.require_lien_waiver && bill.lien_waiver_status !== "received") {
    warnings.push("Lien waiver required")
  }

  return warnings
}

function hasBlockingComplianceIssues(
  bill: VendorBillSummary,
  rules: ComplianceRules,
  status?: ComplianceStatusSummary
) {
  if (!rules.block_payment_on_missing_docs) return false

  if (status && !status.is_compliant) return true

  if (rules.require_lien_waiver && bill.lien_waiver_status !== "received") return true

  return false
}

export function ProjectPayablesClient({
  projectId,
  vendorBills,
  complianceRules,
  complianceStatusByCompanyId,
}: {
  projectId: string
  vendorBills: VendorBillSummary[]
  complianceRules: ComplianceRules
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>
}) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()

  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "approved" | "partial" | "paid">("all")
  const [search, setSearch] = useState("")
  const [paymentAmount, setPaymentAmount] = useState<Record<string, string>>({})
  const [paymentRef, setPaymentRef] = useState<Record<string, string>>({})
  const [paymentMethod, setPaymentMethod] = useState<Record<string, string>>({})

  const [attachmentsOpen, setAttachmentsOpen] = useState(false)
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [selectedBill, setSelectedBill] = useState<VendorBillSummary | null>(null)
  const [billDetailOpen, setBillDetailOpen] = useState(false)
  const [detailRetainage, setDetailRetainage] = useState("")
  const [detailLienWaiver, setDetailLienWaiver] = useState("not_required")

  const totals = useMemo(() => {
    const total = vendorBills.reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    const paid = vendorBills.reduce((sum, b) => sum + (b.paid_cents ?? (b.status === "paid" ? b.total_cents ?? 0 : 0)), 0)
    const open = Math.max(0, total - paid)
    return { total, open, paid }
  }, [vendorBills])

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase()
    return vendorBills.filter((b) => {
      if (statusFilter !== "all" && String(b.status) !== statusFilter) return false
      if (!term) return true
      const haystack = [
        b.company_name,
        b.commitment_title,
        b.bill_number,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(term)
    })
  }, [vendorBills, statusFilter, search])

  const setStatus = (billId: string, status: "pending" | "approved" | "partial" | "paid") => {
    startTransition(async () => {
      try {
        const amountInput = paymentAmount[billId]?.trim()
        const amountCents = amountInput ? Math.round(Number(amountInput) * 100) : undefined
        if ((status === "paid" || status === "partial") && amountInput) {
          if (amountCents === undefined || !Number.isFinite(amountCents) || amountCents <= 0) {
            toast({ title: "Invalid payment amount", description: "Enter a positive amount." })
            return
          }
        }
        await updateProjectVendorBillStatusAction(projectId, billId, {
          status,
          payment_method: paymentMethod[billId] || undefined,
          payment_reference: paymentRef[billId] || undefined,
          payment_amount_cents: status === "paid" || status === "partial" ? amountCents : undefined,
        })
        toast({ title: "Bill updated" })
      } catch (error) {
        toast({ title: "Unable to update bill", description: (error as Error).message })
      }
    })
  }

  useEffect(() => {
    if (!attachmentsOpen || !selectedBill) return
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
  }, [attachmentsOpen, selectedBill])

  useEffect(() => {
    if (!selectedBill) return
    setDetailRetainage(
      selectedBill.retainage_percent != null ? String(selectedBill.retainage_percent) : ""
    )
    setDetailLienWaiver(selectedBill.lien_waiver_status ?? "not_required")
  }, [selectedBill])

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
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">Payables</p>
          <p className="text-xs text-muted-foreground">Project-level AP queue: approve bills and record payments.</p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search company, contract, bill..." className="h-9 w-full sm:w-72" />
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as any)}>
            <SelectTrigger className="h-9 w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="partial">Partial</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Due</TableHead>
              <TableHead className="px-4 py-3">Company</TableHead>
              <TableHead className="px-4 py-3">Commitment</TableHead>
              <TableHead className="px-4 py-3">Bill #</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="px-4 py-3 text-right">Amount</TableHead>
              <TableHead className="px-4 py-3">Compliance</TableHead>
              <TableHead className="w-28 px-4 py-3 text-right">Pay amount</TableHead>
              <TableHead className="w-32 px-4 py-3">Method</TableHead>
              <TableHead className="w-56 px-4 py-3">Payment ref</TableHead>
              <TableHead className="w-32 px-4 py-3 text-right">Attachments</TableHead>
              <TableHead className="w-44 px-4 py-3">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((bill) => {
              const status = bill.company_id ? complianceStatusByCompanyId[bill.company_id] : undefined
              const warnings = complianceWarnings(bill, complianceRules, status)
              const paidCents = bill.paid_cents ?? (bill.status === "paid" ? bill.total_cents ?? 0 : 0)
              const remainingCents = Math.max(0, (bill.total_cents ?? 0) - paidCents)
              const blocking = hasBlockingComplianceIssues(bill, complianceRules, status)
              return (
                <TableRow key={bill.id} className="divide-x align-top hover:bg-muted/40">
                  <TableCell className="text-sm px-4 py-3">{bill.due_date ?? "—"}</TableCell>
                  <TableCell className="text-sm px-4 py-3">{bill.company_name ?? "—"}</TableCell>
                  <TableCell className="text-sm px-4 py-3">
                    <div className="space-y-1">
                      <p className="truncate">{bill.commitment_title ?? "—"}</p>
                      {bill.over_budget ? <Badge variant="destructive">Over budget</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm px-4 py-3">{bill.bill_number ?? "—"}</TableCell>
                  <TableCell className="px-4 py-3">{billBadge(bill.status)}</TableCell>
                  <TableCell className="text-right px-4 py-3">
                    <div>{formatMoneyFromCents(bill.total_cents)}</div>
                    <div className="text-xs text-muted-foreground">
                      Paid {formatMoneyFromCents(paidCents)} • Rem {formatMoneyFromCents(remainingCents)}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    {warnings.length > 0 || bill.lien_waiver_status ? (
                      <div className="space-y-1">
                        {bill.lien_waiver_status ? (
                          <Badge variant="outline">Lien waiver: {bill.lien_waiver_status}</Badge>
                        ) : null}
                        {warnings.slice(0, 2).map((w) => (
                          <Badge key={w} variant="outline">
                            {w}
                          </Badge>
                        ))}
                        {warnings.length > 2 ? (
                          <span className="text-xs text-muted-foreground">+{warnings.length - 2} more</span>
                        ) : null}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    <Input
                      type="number"
                      step="0.01"
                      value={paymentAmount[bill.id] ?? ""}
                      onChange={(e) => setPaymentAmount((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                      placeholder={(remainingCents / 100).toFixed(2)}
                      className="h-9 text-right"
                    />
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Select
                      value={paymentMethod[bill.id] ?? bill.payment_method ?? "check"}
                      onValueChange={(value) => setPaymentMethod((prev) => ({ ...prev, [bill.id]: value }))}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="check">Check</SelectItem>
                        <SelectItem value="ach">ACH</SelectItem>
                        <SelectItem value="wire">Wire</SelectItem>
                        <SelectItem value="card">Card</SelectItem>
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <Input
                      value={paymentRef[bill.id] ?? bill.payment_reference ?? ""}
                      onChange={(e) => setPaymentRef((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                      placeholder="Check/ACH/QBO ref"
                      className="h-9"
                    />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedBill(bill)
                          setBillDetailOpen(true)
                        }}
                      >
                        Details
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedBill(bill)
                          setAttachmentsOpen(true)
                        }}
                      >
                        Files
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={isPending || bill.status === "approved" || bill.status === "paid"}
                        onClick={() => setStatus(bill.id, "approved")}
                      >
                        Approve
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isPending || (bill.status !== "approved" && bill.status !== "partial") || blocking || remainingCents <= 0}
                        onClick={() => setStatus(bill.id, "paid")}
                        title={blocking ? "Cannot mark paid due to compliance issues" : undefined}
                      >
                        Record payment
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}

            {filtered.length > 0 && (
              <TableRow className="divide-x bg-muted/40 font-medium">
                <TableCell className="px-4 py-3 text-sm text-muted-foreground">Totals</TableCell>
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
              <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(totals.total)}</TableCell>
              <TableCell className="px-4 py-3 text-xs text-muted-foreground">Open {formatMoneyFromCents(totals.open)}</TableCell>
              <TableCell className="px-4 py-3" />
              <TableCell className="px-4 py-3" />
              <TableCell className="px-4 py-3" />
              <TableCell className="px-4 py-3" />
              <TableCell className="px-4 py-3 text-right text-muted-foreground">Paid {formatMoneyFromCents(totals.paid)}</TableCell>
            </TableRow>
          )}

          {filtered.length === 0 && (
            <TableRow className="divide-x">
              <TableCell colSpan={12} className="text-center text-muted-foreground py-10">
                No bills found.
              </TableCell>
            </TableRow>
          )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={attachmentsOpen}
        onOpenChange={(nextOpen) => {
          setAttachmentsOpen(nextOpen)
          if (!nextOpen) {
            setSelectedBill(null)
            setAttachments([])
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{selectedBill?.bill_number ? `Bill ${selectedBill.bill_number}` : "Bill files"}</DialogTitle>
            <DialogDescription>Attach vendor invoices and supporting documentation.</DialogDescription>
          </DialogHeader>
          {selectedBill && (
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
          )}
        </DialogContent>
      </Dialog>

      {/* Bill Detail Dialog */}
      <Dialog open={billDetailOpen} onOpenChange={setBillDetailOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selectedBill?.bill_number ? `Bill ${selectedBill.bill_number}` : "Bill Details"}
            </DialogTitle>
            <DialogDescription>
              {selectedBill?.company_name} • {selectedBill?.commitment_title}
            </DialogDescription>
          </DialogHeader>

          {selectedBill && (
            <div className="space-y-6">
              {/* Bill Summary */}
              <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">Amount</p>
                  <p className="text-lg font-bold">{formatMoneyFromCents(selectedBill.total_cents)}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Status</p>
                  <p className="text-lg">{billBadge(selectedBill.status)}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Bill Date</p>
                  <p className="text-sm">{selectedBill.bill_date ? new Date(selectedBill.bill_date).toLocaleDateString() : "—"}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Due Date</p>
                  <p className="text-sm">{selectedBill.due_date ? new Date(selectedBill.due_date).toLocaleDateString() : "—"}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Paid</p>
                  <p className="text-sm">{formatMoneyFromCents(selectedBill.paid_cents)}</p>
                </div>
                <div>
                  <p className="text-sm font-medium">Remaining</p>
                  <p className="text-sm">
                    {formatMoneyFromCents(Math.max(0, (selectedBill.total_cents ?? 0) - (selectedBill.paid_cents ?? 0)))}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <p className="text-sm font-medium">Retainage %</p>
                  <Input
                    type="number"
                    step="0.1"
                    value={detailRetainage}
                    onChange={(e) => setDetailRetainage(e.target.value)}
                    placeholder="0"
                    className="h-9"
                  />
                  <p className="text-xs text-muted-foreground">
                    Retained {formatMoneyFromCents(
                      (() => {
                        if (!detailRetainage.trim()) return selectedBill.retainage_cents ?? 0
                        const percent = Number(detailRetainage)
                        if (!Number.isFinite(percent)) return selectedBill.retainage_cents ?? 0
                        return Math.round(((selectedBill.total_cents ?? 0) * percent) / 100)
                      })(),
                    )}
                  </p>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium">Lien waiver</p>
                  <Select value={detailLienWaiver} onValueChange={setDetailLienWaiver}>
                    <SelectTrigger className="h-9">
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

              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={isPending}
                  onClick={() => {
                    const retainagePercent = detailRetainage.trim() ? Number(detailRetainage) : undefined
                    if (detailRetainage.trim()) {
                      if (retainagePercent === undefined || !Number.isFinite(retainagePercent) || retainagePercent < 0) {
                        toast({ title: "Invalid retainage", description: "Enter a valid percentage." })
                        return
                      }
                    }
                    startTransition(async () => {
                      try {
                        await updateProjectVendorBillStatusAction(projectId, selectedBill.id, {
                          status: selectedBill.status as any,
                          retainage_percent: retainagePercent,
                          lien_waiver_status: detailLienWaiver as any,
                        })
                        toast({ title: "AP details updated" })
                      } catch (error: any) {
                        toast({ title: "Unable to update AP details", description: error?.message ?? "Try again." })
                      }
                    })
                  }}
                >
                  Save AP details
                </Button>
              </div>

              {/* Approval & Payment History */}
              <div>
                <h3 className="text-sm font-medium mb-3">History</h3>
                <div className="space-y-3">
                  {selectedBill.approved_at && (
                    <div className="flex items-center justify-between p-3 border rounded">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                        <span className="text-sm font-medium">Approved</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(selectedBill.approved_at).toLocaleString()}
                      </span>
                    </div>
                  )}

                  {selectedBill.paid_at && (
                    <div className="flex items-center justify-between p-3 border rounded">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                        <span className="text-sm font-medium">Paid</span>
                        {selectedBill.payment_reference && (
                          <span className="text-xs text-muted-foreground">({selectedBill.payment_reference})</span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {new Date(selectedBill.paid_at).toLocaleString()}
                      </span>
                    </div>
                  )}

                  {!selectedBill.approved_at && !selectedBill.paid_at && (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      No approval or payment history yet
                    </p>
                  )}
                </div>
              </div>

              {/* Compliance Warnings */}
              {(() => {
                const status = selectedBill.company_id
                  ? complianceStatusByCompanyId[selectedBill.company_id]
                  : undefined
                const warnings = complianceWarnings(selectedBill, complianceRules, status)
                const blocking = hasBlockingComplianceIssues(selectedBill, complianceRules, status)

                if (warnings.length === 0) return null

                return (
                <div>
                  <h3 className="text-sm font-medium mb-3">
                    Compliance Issues
                    {blocking && (
                      <span className="ml-2 text-xs bg-red-100 text-red-800 px-2 py-1 rounded">
                        Blocking Payment
                      </span>
                    )}
                  </h3>
                  <div className="space-y-2">
                    {warnings.map((warning, index) => {
                      const isBlocking = warning.includes("expired") || warning.includes("missing")
                      return (
                        <div key={index} className={`flex items-center gap-2 p-2 border rounded text-sm ${isBlocking ? 'bg-red-50 border-red-200' : 'bg-yellow-50 border-yellow-200'}`}>
                          <span className={isBlocking ? "text-red-600" : "text-yellow-600"}>⚠️</span>
                          <span className={isBlocking ? "text-red-800" : "text-yellow-800"}>{warning}</span>
                          {isBlocking && <span className="ml-auto text-xs text-red-600 font-medium">Blocks Payment</span>}
                        </div>
                      )
                    })}
                  </div>

                  {status && (
                    <div className="mt-3 rounded-lg border bg-muted/20 p-3 text-sm">
                      {status.missing.length > 0 && (
                        <div className="space-y-1">
                          <p className="font-medium">Missing required documents</p>
                          <div className="flex flex-wrap gap-2">
                            {status.missing.map((dt) => (
                              <Badge key={dt.id} variant="outline">
                                {dt.name}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {status.expired.length > 0 && (
                        <div className={status.missing.length > 0 ? "mt-3 space-y-1" : "space-y-1"}>
                          <p className="font-medium">Expired documents</p>
                          <div className="flex flex-wrap gap-2">
                            {status.expired.map((doc) => (
                              <Badge key={doc.id} variant="outline">
                                {doc.document_type?.name ?? "Document"}{doc.expiry_date ? ` (exp ${doc.expiry_date})` : ""}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}

                      {status.pending_review.length > 0 && (
                        <div className={status.missing.length > 0 || status.expired.length > 0 ? "mt-3 space-y-1" : "space-y-1"}>
                          <p className="font-medium">Pending review</p>
                          <div className="flex flex-wrap gap-2">
                            {status.pending_review.map((doc) => (
                              <Badge key={doc.id} variant="outline">
                                {doc.document_type?.name ?? "Document"}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                )
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
