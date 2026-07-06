import { PageLayout } from "@/components/layout/page-layout"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"

import { PayablesDesk } from "./payables-desk"

export const dynamic = "force-dynamic"

export default async function PayablesPage() {
  const data = await loadOrgPayablesDesk()

  return (
    <PageLayout title="Payables" fullBleed>
      <PayablesDesk data={data} />
    </PageLayout>
  )
}
