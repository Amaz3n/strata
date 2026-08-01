import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess, loadSubPortalData } from "@/lib/services/portal-access"
import { SubContractsCard } from "@/components/portal/sub/sub-contracts-card"

interface SubCommitmentsPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubCommitmentsPage({ params }: SubCommitmentsPageProps) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_commitments",
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

  return (
    <>
      <PortalPageHeader
        title="Contracts"
        description="The scopes you have been awarded on this project, what you have billed, and what is left to bill."
      />

      {data.commitments.length === 0 ? (
        <div className="border border-border bg-card px-4 py-12 text-center">
          <p className="text-sm font-medium">No contracts yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Scopes the builder awards to your company appear here.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.commitments.map((commitment) => (
            <SubContractsCard
              key={commitment.id}
              commitment={commitment}
              token={token}
              canSubmitInvoice={access.permissions.can_submit_invoices ?? true}
            />
          ))}
        </div>
      )}
    </>
  )
}
