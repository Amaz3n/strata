import { PageLayout } from "@/components/layout/page-layout"
import { Suspense } from "react"

import { OrgBillingWorkspace } from "@/components/invoices/org-billing-workspace"
import { BillingSkeleton } from "@/components/layout/desk-skeletons"

export default function BillingPage() {
  return (
    <Suspense fallback={<PageLayout title="Billing" fullBleed><BillingSkeleton /></PageLayout>}>
      <OrgBillingWorkspace />
    </Suspense>
  )
}
