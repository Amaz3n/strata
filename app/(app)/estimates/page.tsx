import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { listContacts } from "@/lib/services/contacts"
import { EstimatesClient } from "@/components/estimates/estimates-client"
import { listEstimatesAction, listEstimateTemplatesAction } from "./actions"
import { listCostCodes } from "@/lib/services/cost-codes"

export const dynamic = "force-dynamic"

interface EstimatesPageProps {
  searchParams: Promise<Record<string, string | string[]>>
}

async function EstimatesData({ searchParams }: EstimatesPageProps) {
  const [estimates, contacts, templates, costCodes, resolvedSearchParams] = await Promise.all([
    listEstimatesAction(),
    listContacts(),
    listEstimateTemplatesAction(),
    listCostCodes().catch(() => []),
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

  return (
    <div className="space-y-6">
      <EstimatesClient
        estimates={estimates}
        contacts={contacts}
        templates={templates}
        costCodes={costCodes}
        initialRecipientId={recipient}
        initialProjectId={project}
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
