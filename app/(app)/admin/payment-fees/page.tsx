import { PaymentFeesClient } from "@/components/admin/payment-fees-client"
import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import {
  listPaymentFeePolicies,
  listPaymentFeePolicyOrganizations,
} from "@/lib/services/payment-fee-policies"

export const dynamic = "force-dynamic"

export default async function PaymentFeesPage() {
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
