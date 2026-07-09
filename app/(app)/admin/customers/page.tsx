import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { CustomersClient } from "@/components/admin/customers-table"
import { getCustomers } from "@/lib/services/admin"
import {
  activateCustomerBillingAction,
  extendCustomerTrialAction,
  updateCustomerDetailsAction,
  updateCustomerSubscriptionAction,
} from "@/app/(app)/admin/customers/actions"
import { enterOrgContextAction, setOrganizationStatusAction } from "@/app/(app)/platform/actions"
import { listActiveSubscriptionPlans } from "@/lib/services/billing"
import { unwrapAction } from "@/lib/action-result"

export const dynamic = 'force-dynamic'

async function activateCustomerBilling(formData: FormData) {
  "use server"
  return unwrapAction(await activateCustomerBillingAction(formData))
}

async function extendCustomerTrial(formData: FormData) {
  "use server"
  unwrapAction(await extendCustomerTrialAction(formData))
}

async function updateCustomerDetails(formData: FormData) {
  "use server"
  unwrapAction(await updateCustomerDetailsAction(formData))
}

async function updateCustomerSubscription(formData: FormData) {
  "use server"
  unwrapAction(await updateCustomerSubscriptionAction(formData))
}

async function enterOrgContext(formData: FormData) {
  "use server"
  unwrapAction(await enterOrgContextAction(formData))
}

async function setOrganizationStatus(formData: FormData) {
  "use server"
  unwrapAction(await setOrganizationStatusAction(formData))
}

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  await requireAnyPermissionGuard(["billing.manage", "platform.billing.manage"])

  const search = typeof searchParams.search === 'string' ? searchParams.search : ''
  const status = typeof searchParams.status === 'string' ? searchParams.status : 'all'
  const plan = typeof searchParams.plan === 'string' ? searchParams.plan : 'all'
  const page = typeof searchParams.page === 'string' ? parseInt(searchParams.page) : 1

  const [{ customers, totalCount, hasNextPage, hasPrevPage }, subscriptionPlans] = await Promise.all([
    getCustomers({
      search,
      status: status === 'all' ? undefined : status,
      plan: plan === 'all' ? undefined : plan,
      page,
      limit: 20,
    }),
    listActiveSubscriptionPlans(),
  ])

  return (
    <PageLayout
      title="Customer Management"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Customer Management" }
      ]}
    >
      <div className="space-y-6">
        <CustomersClient
          customers={customers}
          totalCount={totalCount}
          hasNextPage={hasNextPage}
          hasPrevPage={hasPrevPage}
          search={search}
          status={status}
          plan={plan}
          page={page}
          subscriptionPlans={subscriptionPlans}
          onActivateBilling={activateCustomerBilling}
          onExtendTrial={extendCustomerTrial}
          onUpdateCustomer={updateCustomerDetails}
          onUpdateSubscription={updateCustomerSubscription}
          onEnterContext={enterOrgContext}
          onSetStatus={setOrganizationStatus}
        />
      </div>
    </PageLayout>
  )
}
