import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PaymentFeesClient } from "@/components/admin/payment-fees-client"
import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import {
  listPaymentFeePolicies,
  listPaymentFeePolicyOrganizations,
} from "@/lib/services/payment-fee-policies"


async function PaymentFeesPageContent() {
  await requirePermissionGuard("platform.billing.manage")

  const [policies, organizations] = await Promise.all([
    listPaymentFeePolicies(),
    listPaymentFeePolicyOrganizations(),
  ])

  return (
    <PageLayout
      title="Payment Fees"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Payment Fees" },
      ]}
    >
      <PaymentFeesClient initialPolicies={policies} organizations={organizations} />
    </PageLayout>
  )
}

export default function PaymentFeesPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PaymentFeesPageContent />
    </Suspense>
  )
}
