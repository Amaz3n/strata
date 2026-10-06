import { PageLayout } from "@/components/layout/page-layout"
import { Suspense } from "react"

import { OrgBillingWorkspace } from "@/components/invoices/org-billing-workspace"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"

export default function BillingPage() {
  return (
    <Suspense fallback={<PageLayout title="Billing" fullBleed><PageLoadingSkeleton /></PageLayout>}>
      <OrgBillingWorkspace />
    </Suspense>
  )
}
