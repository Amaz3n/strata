import { notFound } from "next/navigation"
import Link from "next/link"
import { CheckCircle2, FileSignature } from "lucide-react"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { SubmitInvoiceButton } from "@/components/portal/sub/sub-invoice-dialog"
import {
  assertPortalActionAccess,
  loadSubPortalData,
  loadSubPortalShellContext,
} from "@/lib/services/portal-access"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { formatLocalDate, formatMoneyCents } from "@/lib/utils"

interface SubBillsPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

function canSignWaiver(status: string, lienWaiverStatus?: string | null): boolean {
  return (status === "approved" || status === "partial") && lienWaiverStatus !== "received"
}

export default async function SubBillsPage({ params }: SubBillsPageProps) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_bills",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  const invoiceableCommitments = data.commitments.filter(
    (commitment) => commitment.status === "approved" && commitment.remaining_cents > 0,
  )
  const shell = await loadSubPortalShellContext({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })
  const complianceBlocked = shell.blocksPaymentOnCompliance && !shell.isCompliant

  return (
    <>
      <PortalPageHeader
        title="Invoices"
        description="Every invoice you have submitted on this project, and where each one stands."
        actions={
          access.permissions.can_submit_invoices && invoiceableCommitments.length > 0 ? (
            <SubmitInvoiceButton
              token={token}
              commitments={invoiceableCommitments}
              companyName={data.company.name}
              complianceBlocked={complianceBlocked}
            />
          ) : null
        }
      />

      {data.bills.length === 0 ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <p className="text-sm font-medium">No invoices submitted yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Invoices you submit against your contracts appear here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border border border-border bg-card">
          {data.bills.map((bill) => (
            <li key={bill.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{bill.bill_number}</p>
                <p className="truncate text-xs text-muted-foreground">{bill.commitment_title}</p>
                {bill.due_date ? (
                  <p className="text-xs tabular-nums text-muted-foreground">
                    Due {formatLocalDate(bill.due_date, "MMM d, yyyy")}
                  </p>
                ) : null}
                {bill.lien_waiver_status === "received" ? (
                  <p className="mt-1 flex items-center gap-1 text-xs text-success">
                    <CheckCircle2 className="size-3" />
                    Waiver received
                  </p>
                ) : null}
              </div>
              <div className="shrink-0 text-right">
                <Badge variant="outline" className="mb-1 text-xs capitalize">
                  {bill.status}
                </Badge>
                <p className="text-sm font-medium tabular-nums">{formatMoneyCents(bill.total_cents)}</p>
                {canSignWaiver(bill.status, bill.lien_waiver_status) ? (
                  <Button asChild size="sm" className="mt-2 h-8">
                    <Link href={`/s/${token}/waivers/${bill.id}`}>
                      <FileSignature className="mr-1 size-3.5" />
                      Sign waiver
                    </Link>
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
