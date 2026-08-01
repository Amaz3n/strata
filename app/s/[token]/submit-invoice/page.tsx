import Link from "next/link"
import { notFound } from "next/navigation"
import { ShieldAlert } from "lucide-react"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { Button } from "@/components/ui/button"
import {
  assertPortalActionAccess,
  loadSubPortalData,
  loadSubPortalShellContext,
} from "@/lib/services/portal-access"
import { SubmitInvoiceClient } from "./submit-invoice-client"

interface SubmitInvoicePageProps {
  params: Promise<{ token: string }>
  searchParams: Promise<{ commitment?: string }>
}

export const revalidate = 0

export default async function SubmitInvoicePage({
  params,
  searchParams,
}: SubmitInvoicePageProps) {
  const { token } = await params
  const { commitment: preselectedCommitmentId } = await searchParams

  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_submit_invoices",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const [data, shell] = await Promise.all([
    loadSubPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
    }),
    loadSubPortalShellContext({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
    }),
  ])

  // A link from an email must hit the same gate the in-page button does.
  const complianceBlocked = shell.blocksPaymentOnCompliance && !shell.isCompliant

  // Filter to only approved commitments with remaining budget
  const eligibleCommitments = data.commitments.filter(
    (c) => c.status === "approved" && c.remaining_cents > 0
  )

  return (
    <>
      <PortalPageHeader
        title="Submit invoice"
        description="Bill against one of your contracts. The builder reviews it before payment."
      />

      {complianceBlocked ? (
        <div className="border border-warning/30 bg-warning/10 px-4 py-6">
          <p className="flex items-start gap-2.5 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              <span className="font-medium">Finish your compliance documents first.</span>{" "}
              <span className="text-muted-foreground">
                This builder holds payment until every required document is current, so invoices
                cannot be submitted yet.
              </span>
            </span>
          </p>
          <Button asChild size="sm" className="mt-4">
            <Link href={`/s/${token}/compliance`}>Go to compliance</Link>
          </Button>
        </div>
      ) : eligibleCommitments.length === 0 ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <p className="text-sm font-medium">Nothing available to invoice</p>
          <p className="mt-1 text-sm text-muted-foreground">
            A contract must be approved and have remaining budget before you can invoice against it.
          </p>
        </div>
      ) : (
        <SubmitInvoiceClient
          token={token}
          commitments={eligibleCommitments}
          preselectedCommitmentId={preselectedCommitmentId}
          companyName={data.company.name}
        />
      )}
    </>
  )
}
