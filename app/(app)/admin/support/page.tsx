import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { SupportContractsTable } from "@/components/admin/support-contracts-table"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = "force-dynamic"

export default async function SupportPage() {
  await requireAnyPermissionGuard(["billing.manage", "platform.support.read"])

  return (
    <PageLayout
      title="Support Contracts"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Support Contracts" },
      ]}
    >
      <Suspense fallback={<SupportTableSkeleton />}>
        <SupportContractsTable />
      </Suspense>
    </PageLayout>
  )
}

function SupportTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}
