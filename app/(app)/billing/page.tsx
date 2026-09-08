import { Suspense } from "react"

import { OrgBillingWorkspace } from "@/components/invoices/org-billing-workspace"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"

export default function BillingPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <OrgBillingWorkspace />
    </Suspense>
  )
}
