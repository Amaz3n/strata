import Link from "next/link"
import { notFound } from "next/navigation"
import { Clock, Phone, Plus, ReceiptText } from "lucide-react"

import { PortalActionInbox, sortPortalActions, type PortalAction } from "@/components/portal/action-inbox"
import { PortalMoneyStrip } from "@/components/portal/money-strip"
import { SubmitInvoiceButton } from "@/components/portal/sub/sub-invoice-dialog"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { Button } from "@/components/ui/button"
import {
  assertPortalActionAccess,
  loadSubPortalData,
  loadSubPortalShellContext,
  recordPortalAccess,
} from "@/lib/services/portal-access"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getLatestPrequalificationWithClient } from "@/lib/services/prequalification"
import { listWarrantyVisitsForCompanyPortal } from "@/lib/services/warranty-operations"
import { subRfiBucket } from "@/lib/portal/rfi-buckets"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { formatLocalDate, formatMoneyCents, parseLocalDate } from "@/lib/utils"

interface SubPortalHomeProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

/** Bills that are approved but whose lien waiver has not come back yet. */
function needsWaiver(status: string, lienWaiverStatus?: string | null) {
  return (status === "approved" || status === "partial") && lienWaiverStatus !== "received"
}

export default async function SubPortalHome({ params }: SubPortalHomeProps) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  try {
    await recordPortalAccess(access.id)
  } catch {
    notFound()
  }

  const supabase = createServiceSupabaseClient()
  const [shell, data, complianceStatus, prequalification, warrantyVisits] = await Promise.all([
    loadSubPortalShellContext({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
    }),
    loadSubPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
      scopedRfiId: access.scoped_rfi_id ?? null,
      portalToken: token,
    }),
    getCompanyComplianceStatusWithClient(supabase, access.org_id, access.company_id),
    getLatestPrequalificationWithClient(supabase, access.org_id, access.company_id),
    listWarrantyVisitsForCompanyPortal({
      orgId: access.org_id,
      companyId: access.company_id,
      projectId: access.project_id,
    }),
  ])

  const root = `/s/${token}`
  const today = new Date()
  const actions: PortalAction[] = []

  // Overdue RFIs get their own row — a sub needs to know which one is late,
  // not that "3 RFIs" are outstanding somewhere. Only questions put *to* the
  // sub belong here; the ones they raised are waiting on the builder.
  const openRfis = data.rfis.filter(
    (rfi) => subRfiBucket(rfi, access.company_id ?? null) === "needs-you",
  )
  const overdueRfis = openRfis.filter((rfi) => {
    const due = parseLocalDate(rfi.due_date)
    return due !== null && due < today
  })
  for (const rfi of overdueRfis) {
    actions.push({
      id: `rfi-${rfi.id}`,
      tone: "critical",
      label: `RFI #${rfi.display_number ?? rfi.rfi_number} is overdue`,
      detail: rfi.subject,
      href: `${root}/rfis`,
    })
  }
  const remainingRfis = openRfis.length - overdueRfis.length
  if (remainingRfis > 0) {
    actions.push({
      id: "rfis",
      tone: "warning",
      label: `${remainingRfis} RFI${remainingRfis === 1 ? "" : "s"} awaiting your response`,
      href: `${root}/rfis`,
    })
  }

  const complianceBlockers =
    complianceStatus.missing.length + complianceStatus.expired.length + complianceStatus.deficiencies.length
  if (complianceBlockers > 0) {
    actions.push({
      id: "compliance",
      tone: "critical",
      label: `${complianceBlockers} compliance document${complianceBlockers === 1 ? "" : "s"} need attention`,
      detail: "Missing or expired documents can hold up your payments",
      href: `${root}/compliance`,
    })
  }
  if (complianceStatus.expiring_soon.length > 0) {
    actions.push({
      id: "compliance-expiring",
      tone: "warning",
      label: `${complianceStatus.expiring_soon.length} document${complianceStatus.expiring_soon.length === 1 ? "" : "s"} expiring soon`,
      href: `${root}/compliance`,
    })
  }

  if (data.pendingSubmittalCount > 0) {
    actions.push({
      id: "submittals",
      tone: "warning",
      label: `${data.pendingSubmittalCount} submittal${data.pendingSubmittalCount === 1 ? "" : "s"} pending`,
      href: `${root}/submittals`,
    })
  }

  if (data.pendingPunchCount > 0) {
    actions.push({
      id: "punch",
      tone: "warning",
      label: `${data.pendingPunchCount} punch item${data.pendingPunchCount === 1 ? "" : "s"} assigned to you`,
      href: `${root}/punch`,
    })
  }

  const waiverBills = data.bills.filter((bill) => needsWaiver(bill.status, bill.lien_waiver_status))
  for (const bill of waiverBills) {
    actions.push({
      id: `waiver-${bill.id}`,
      tone: "warning",
      label: `Sign the lien waiver for ${bill.bill_number}`,
      detail: `${formatMoneyCents(bill.total_cents)} · ${bill.commitment_title}`,
      href: `${root}/waivers/${bill.id}`,
    })
  }

  if (prequalification?.status === "requested") {
    actions.push({
      id: "prequalification",
      tone: "warning",
      label: "Prequalification requested",
      detail: "The builder needs your company information",
      href: `${root}/prequalification`,
    })
  }

  const unconfirmedVisits = warrantyVisits.filter((visit) => visit.status === "scheduled")
  if (unconfirmedVisits.length > 0) {
    actions.push({
      id: "warranty",
      tone: "warning",
      label: `Confirm ${unconfirmedVisits.length} warranty appointment${unconfirmedVisits.length === 1 ? "" : "s"}`,
      href: `${root}/warranty`,
    })
  }

  const recentBills = data.bills.slice(0, 5)
  const invoiceableCommitments = data.commitments.filter(
    (commitment) => commitment.status === "approved" && commitment.remaining_cents > 0,
  )
  // Only gate invoicing where the builder's own rules hold payment for it —
  // otherwise the portal would be stricter than the org it represents.
  const complianceBlocked = shell.blocksPaymentOnCompliance && !complianceStatus.is_compliant

  return (
    <>
      <PortalPageHeader
        title={data.company.name}
        description={data.company.trade ?? undefined}
        actions={
          <>
            {shell.features.showTime && access.permissions.can_submit_time ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`${root}/time`}>
                  <Clock className="size-4" />
                  Log time
                </Link>
              </Button>
            ) : null}
            {shell.features.showExpenses && access.permissions.can_submit_expenses ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`${root}/expenses`}>
                  <ReceiptText className="size-4" />
                  Expense
                </Link>
              </Button>
            ) : null}
            {access.permissions.can_submit_invoices && invoiceableCommitments.length > 0 ? (
              <SubmitInvoiceButton
                token={token}
                commitments={invoiceableCommitments}
                companyName={data.company.name}
                icon={<Plus className="size-4" />}
                complianceBlocked={complianceBlocked}
              />
            ) : null}
          </>
        }
      />

      <div className="space-y-6">
        <PortalActionInbox actions={sortPortalActions(actions)} />

        <section>
          <h2 className="mb-2 text-sm font-semibold text-foreground">Your contract to date</h2>
          <PortalMoneyStrip
            figures={[
              { label: "Contracted", cents: data.financialSummary.total_committed },
              { label: "Billed", cents: data.financialSummary.total_billed },
              {
                label: "Pending approval",
                cents: data.financialSummary.pending_approval,
                tone: "warning",
              },
              { label: "Paid", cents: data.financialSummary.total_paid, tone: "success" },
            ]}
          />
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Recent invoices</h2>
            {data.bills.length > recentBills.length ? (
              <Link href={`${root}/bills`} className="text-sm text-primary hover:underline">
                View all {data.bills.length}
              </Link>
            ) : null}
          </div>

          {recentBills.length === 0 ? (
            <p className="border border-border bg-card px-4 py-5 text-sm text-muted-foreground">
              You have not submitted any invoices on this project yet.
            </p>
          ) : (
            <div className="overflow-x-auto border border-border bg-card">
              <table className="w-full min-w-[32rem] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2 font-medium">Invoice</th>
                    <th className="px-4 py-2 font-medium">Contract</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {recentBills.map((bill) => (
                    <tr key={bill.id}>
                      <td className="px-4 py-2.5 font-medium">{bill.bill_number}</td>
                      <td className="max-w-[12rem] truncate px-4 py-2.5 text-muted-foreground">
                        {bill.commitment_title}
                      </td>
                      <td className="px-4 py-2.5 capitalize text-muted-foreground">{bill.status}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatMoneyCents(bill.total_cents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {data.schedule.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-foreground">Your upcoming work</h2>
            <ul className="divide-y divide-border border border-border bg-card">
              {data.schedule
                .filter((item) => item.status === "planned" || item.status === "in_progress")
                .slice(0, 4)
                .map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0 truncate text-sm">{item.name}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {item.start_date ? formatLocalDate(item.start_date, "MMM d") : "Unscheduled"}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        {data.projectManager ? (
          <section className="border border-border bg-card px-4 py-3">
            <p className="text-xs text-muted-foreground">Your contact on this project</p>
            <p className="mt-0.5 text-sm font-medium">{data.projectManager.full_name}</p>
            {data.projectManager.phone ? (
              <a
                href={`tel:${data.projectManager.phone}`}
                className="mt-1 inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                <Phone className="size-3.5" />
                {data.projectManager.phone}
              </a>
            ) : null}
          </section>
        ) : null}
      </div>
    </>
  )
}
