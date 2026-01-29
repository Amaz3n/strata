import { PageLayout } from "@/components/layout/page-layout"
import { listContacts } from "@/lib/services/contacts"
import { EstimatesClient } from "@/components/estimates/estimates-client"
import { listEstimatesAction, listEstimateTemplatesAction } from "./actions"
import { listCostCodes } from "@/lib/services/cost-codes"

export const dynamic = "force-dynamic"

export default async function EstimatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[]>> }) {
  const [estimates, contacts, templates, costCodes, resolvedSearchParams] = await Promise.all([
    listEstimatesAction(),
    listContacts(),
    listEstimateTemplatesAction(),
    listCostCodes().catch(() => []),
    searchParams,
  ])

  const recipient =
    typeof resolvedSearchParams?.recipient === "string" ? resolvedSearchParams.recipient : undefined

  return (
    <PageLayout title="Estimates">
      <div className="space-y-6">
        <EstimatesClient
          estimates={estimates}
          contacts={contacts}
          templates={templates}
          costCodes={costCodes}
          initialRecipientId={recipient}
        />
      </div>
    </PageLayout>
  )
}
