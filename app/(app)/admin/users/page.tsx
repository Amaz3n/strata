import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { Skeleton } from "@/components/ui/skeleton"
import { UsersActivityClient } from "@/components/admin/users-activity-client"
import { getPlatformUsers } from "@/lib/services/admin"

export const dynamic = "force-dynamic"

async function UsersData() {
  const data = await getPlatformUsers()
  return <UsersActivityClient data={data} />
}

export default async function UsersPage() {
  await requireAnyPermissionGuard(["billing.manage", "platform.support.read"])

  return (
    <PageLayout
      title="User Activity"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "User Activity" },
      ]}
    >
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<UsersSkeleton />}>
          <UsersData />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function UsersSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="grid grid-cols-2 gap-px border-b bg-border sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-card px-4 py-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-10" />
          </div>
        ))}
      </div>
      <div className="space-y-2 p-4">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}
