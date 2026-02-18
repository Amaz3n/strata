import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { CustomersClient } from "@/components/admin/customers-table"
import { getCustomers } from "@/lib/services/admin"
import { extendCustomerTrialAction, provisionCustomerAction } from "@/app/(app)/admin/customers/actions"
import { enterOrgContextAction, setOrganizationStatusAction } from "@/app/(app)/platform/actions"

export const dynamic = 'force-dynamic'

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

  const { customers, totalCount, hasNextPage, hasPrevPage } = await getCustomers({
    search,
    status: status === 'all' ? undefined : status,
    plan: plan === 'all' ? undefined : plan,
    page,
    limit: 20,
  })

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
          onProvision={provisionCustomerAction}
          onExtendTrial={extendCustomerTrialAction}
          onEnterContext={enterOrgContextAction}
          onSetStatus={setOrganizationStatusAction}
        />
      </div>
    </PageLayout>
  )
}
