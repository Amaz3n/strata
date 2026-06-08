import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { listContacts } from "@/lib/services/contacts"
import { EstimatesClient } from "@/components/estimates/estimates-client"
import { listEstimatesAction } from "./actions"
import { listCostCodes } from "@/lib/services/cost-codes"
import { requireOrgContext } from "@/lib/services/context"
import { getOrgBranding } from "@/lib/services/estimate-portal"

export const dynamic = "force-dynamic"

interface EstimatesPageProps {
  searchParams: Promise<Record<string, string | string[]>>
}

async function EstimatesData({ searchParams }: EstimatesPageProps) {
  const { orgId } = await requireOrgContext()
  const [estimates, contacts, costCodes, branding, resolvedSearchParams] = await Promise.all([
    listEstimatesAction(),
    listContacts(),
    listCostCodes().catch(() => []),
    getOrgBranding(orgId),
    searchParams,
  ])

  const recipient =
    typeof resolvedSearchParams?.recipient === "string" ? resolvedSearchParams.recipient : undefined
  const project =
    typeof resolvedSearchParams?.project === "string"
      ? resolvedSearchParams.project
      : typeof resolvedSearchParams?.project_id === "string"
        ? resolvedSearchParams.project_id
        : undefined
  const prospect =
    typeof resolvedSearchParams?.prospect === "string"
      ? resolvedSearchParams.prospect
      : typeof resolvedSearchParams?.prospect_id === "string"
        ? resolvedSearchParams.prospect_id
        : undefined

  return (
    <div className="space-y-6">
      <EstimatesClient
        key={orgId}
        estimates={estimates}
        contacts={contacts}
        costCodes={costCodes}
        defaultTerms={branding.estimateTermsTemplate ?? ""}
        initialRecipientId={recipient}
        initialProjectId={project}
        initialProspectId={prospect}
      />
    </div>
  )
}

export default function EstimatesPage(props: EstimatesPageProps) {
  return (
    <PageLayout title="Estimates">
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <EstimatesData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
