import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { CustomersClient } from "@/components/admin/customers-table"
import { ProvisionOrgSheet } from "@/components/platform/provision-org-sheet"
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

async function CustomersPageContent({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  await requireAnyPermissionGuard(["billing.manage", "platform.billing.manage"])
  const params = await searchParams

  const search = typeof params.search === 'string' ? params.search : ''
  const status = typeof params.status === 'string' ? params.status : 'all'
  const plan = typeof params.plan === 'string' ? params.plan : 'all'
  const page = typeof params.page === 'string' ? parseInt(params.page) : 1

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
        {/* Provisioning creates the row this page manages, so it lives here. */}
        <div className="flex items-center justify-between gap-3 border-b pb-3">
          <p className="text-sm text-muted-foreground">
            {totalCount.toLocaleString()} {totalCount === 1 ? "organization" : "organizations"}
          </p>
          <ProvisionOrgSheet />
        </div>
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

export default function CustomersPage(props: Parameters<typeof CustomersPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <CustomersPageContent {...props} />
    </Suspense>
  )
}
