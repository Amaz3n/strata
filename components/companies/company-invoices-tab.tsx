"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import type { CommitmentSummary } from "@/lib/services/commitments"
import type { VendorBillSummary } from "@/lib/services/vendor-bills"
import { updateVendorBillStatusAction } from "@/app/companies/[id]/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"

function formatMoneyFromCents(cents?: number | null) {
  const dollars = (cents ?? 0) / 100
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function billBadge(status?: string) {
  const normalized = (status ?? "pending").toLowerCase()
  if (normalized === "paid") return <Badge variant="secondary">Paid</Badge>
  if (normalized === "approved") return <Badge variant="outline">Approved</Badge>
  return <Badge variant="outline">Pending</Badge>
}

export function CompanyInvoicesTab({
  companyId,
  commitments,
  vendorBills,
}: {
  companyId: string
  commitments: CommitmentSummary[]
  vendorBills: VendorBillSummary[]
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [paymentRef, setPaymentRef] = useState<Record<string, string>>({})

  const totals = useMemo(() => {
    const contractTotal = commitments.reduce((sum, c) => sum + (c.total_cents ?? 0), 0)
    const billed = vendorBills.reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    const paid = vendorBills.filter((b) => b.status === "paid").reduce((sum, b) => sum + (b.total_cents ?? 0), 0)
    return { contractTotal, billed, paid, remaining: Math.max(0, contractTotal - billed) }
  }, [commitments, vendorBills])

  const billedByCommitment = useMemo(() => {
    const map = new Map<string, number>()
    for (const bill of vendorBills) {
      if (!bill.commitment_id) continue
      map.set(bill.commitment_id, (map.get(bill.commitment_id) ?? 0) + (bill.total_cents ?? 0))
    }
    return map
  }, [vendorBills])

  const setStatus = (billId: string, status: "pending" | "approved" | "paid") => {
    startTransition(async () => {
      try {
        await updateVendorBillStatusAction(billId, companyId, {
          status,
          payment_reference: paymentRef[billId] || undefined,
        })
        toast({ title: "Invoice updated" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to update invoice", description: (error as Error).message })
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-3">Invoice date</TableHead>
              <TableHead className="px-4 py-3">Project</TableHead>
              <TableHead className="px-4 py-3">Contract</TableHead>
              <TableHead className="px-4 py-3">Invoice No.</TableHead>
              <TableHead className="px-4 py-3">Status</TableHead>
              <TableHead className="text-right px-4 py-3">Amount</TableHead>
              <TableHead className="text-right px-4 py-3">Contract remaining</TableHead>
              <TableHead className="w-56 px-4 py-3">Payment ref</TableHead>
              <TableHead className="w-44 px-4 py-3">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vendorBills.map((bill) => (
              <TableRow key={bill.id} className="divide-x align-top hover:bg-muted/40">
                <TableCell className="text-sm px-4 py-3">{bill.bill_date ?? bill.created_at?.slice(0, 10) ?? "—"}</TableCell>
                <TableCell className="text-sm px-4 py-3">{bill.project_name ?? "—"}</TableCell>
                <TableCell className="text-sm px-4 py-3">{bill.commitment_title ?? "—"}</TableCell>
                <TableCell className="text-sm px-4 py-3">{bill.bill_number ?? "—"}</TableCell>
                <TableCell className="px-4 py-3">{billBadge(bill.status)}</TableCell>
                <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(bill.total_cents)}</TableCell>
                <TableCell className="text-right px-4 py-3">
                  {bill.commitment_id && bill.commitment_total_cents != null
                    ? formatMoneyFromCents((bill.commitment_total_cents ?? 0) - (billedByCommitment.get(bill.commitment_id) ?? 0))
                    : "—"}
                </TableCell>
                <TableCell className="px-4 py-3">
                  <Input
                    value={paymentRef[bill.id] ?? bill.payment_reference ?? ""}
                    onChange={(e) => setPaymentRef((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                    placeholder="Check/ACH/QBO ref"
                    className="h-9"
                  />
                </TableCell>
                <TableCell className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" disabled={isPending} onClick={() => setStatus(bill.id, "approved")}>
                      Approve
                    </Button>
                    <Button variant="secondary" size="sm" disabled={isPending} onClick={() => setStatus(bill.id, "paid")}>
                      Mark paid
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {vendorBills.length > 0 && (
              <TableRow className="divide-x bg-muted/40 font-medium">
                <TableCell className="px-4 py-3 text-sm text-muted-foreground">Totals</TableCell>
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3" />
                <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(totals.billed)}</TableCell>
                <TableCell className="text-right px-4 py-3">{formatMoneyFromCents(totals.remaining)}</TableCell>
                <TableCell className="px-4 py-3" />
                <TableCell className="px-4 py-3 text-right text-muted-foreground">Paid {formatMoneyFromCents(totals.paid)}</TableCell>
              </TableRow>
            )}
            {vendorBills.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                  No vendor invoices yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
