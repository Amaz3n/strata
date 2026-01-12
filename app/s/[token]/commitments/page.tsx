import { notFound } from "next/navigation"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"

import { validatePortalToken, loadSubPortalData } from "@/lib/services/portal-access"
import { PortalHeader } from "@/components/portal/portal-header"
import { Button } from "@/components/ui/button"
import { SubContractsCard } from "@/components/portal/sub/sub-contracts-card"

interface SubCommitmentsPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubCommitmentsPage({ params }: SubCommitmentsPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) notFound()
  if (access.portal_type !== "sub" || !access.company_id) notFound()
  if (!access.permissions.can_view_commitments) notFound()

  const data = await loadSubPortalData({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
    permissions: access.permissions,
  })

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <PortalHeader orgName={data.org.name} project={data.project} />

      <main className="flex-1 mx-auto w-full max-w-xl px-4 py-6 space-y-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
            <Link href={`/s/${token}`}>
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Dashboard
            </Link>
          </Button>
          <h1 className="text-xl font-semibold">My Contracts</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Contracts and remaining budget for this project.
          </p>
        </div>

        {data.commitments.length === 0 ? (
          <div className="rounded-lg border p-6 text-center text-muted-foreground">
            No contracts assigned yet.
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
      </main>
    </div>
  )
}

