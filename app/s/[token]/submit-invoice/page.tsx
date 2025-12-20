import { notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { validatePortalToken, loadSubPortalData } from "@/lib/services/portal-access"
import { Button } from "@/components/ui/button"
import { PortalHeader } from "@/components/portal/portal-header"
import { SubInvoiceForm } from "@/components/portal/sub/sub-invoice-form"

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

  const access = await validatePortalToken(token)

  if (!access) {
    notFound()
  }

  // Must be a sub portal with company_id
  if (access.portal_type !== "sub" || !access.company_id) {
    notFound()
  }

  // Must have permission to submit invoices
  if (!access.permissions.can_submit_invoices) {
    notFound()
  }

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  // Filter to only approved commitments with remaining budget
  const eligibleCommitments = data.commitments.filter(
    (c) => c.status === "approved" && c.remaining_cents > 0
  )

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />

      <main className="flex-1 mx-auto w-full max-w-xl px-4 py-6">
        <div className="mb-6">
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
            <Link href={`/s/${token}`}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">Submit Invoice</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Submit an invoice for review and payment
          </p>
        </div>

        {eligibleCommitments.length === 0 ? (
          <div className="rounded-lg border p-6 text-center">
            <p className="text-muted-foreground">
              No eligible contracts available for invoice submission.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Contracts must be approved and have remaining budget to submit invoices.
            </p>
            <Button asChild className="mt-4">
              <Link href={`/s/${token}`}>Return to Dashboard</Link>
            </Button>
          </div>
        ) : (
          <SubInvoiceForm
            token={token}
            commitments={eligibleCommitments}
            preselectedCommitmentId={preselectedCommitmentId}
            companyName={data.company.name}
          />
        )}
      </main>
    </div>
  )
}
