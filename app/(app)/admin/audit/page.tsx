import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { AuditLogTable } from "@/components/admin/audit-log-table"
import { AuditLogFilters } from "@/components/admin/audit-log-filters"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

export default async function AuditPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  await requireAnyPermissionGuard(["audit.read", "platform.support.read"])

  const search = typeof searchParams.search === 'string' ? searchParams.search : ''
  const action = typeof searchParams.action === 'string' ? searchParams.action : 'all'
  const entityType = typeof searchParams.entityType === 'string' ? searchParams.entityType : 'all'
  const user = typeof searchParams.user === 'string' ? searchParams.user : 'all'
  const page = typeof searchParams.page === 'string' ? parseInt(searchParams.page) : 1

  return (
    <PageLayout
      title="Audit Log"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Audit Log" }
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Audit Log</h1>
          <p className="text-muted-foreground mt-2">
            View all system activity and changes
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>System Activity</CardTitle>
            <CardDescription>
              Complete audit trail of all system changes and user actions
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-12 mb-4" />}>
              <AuditLogFilters
                search={search}
                action={action}
                entityType={entityType}
                user={user}
              />
            </Suspense>

            <Suspense fallback={<AuditLogTableSkeleton />}>
              <AuditLogTable
                search={search}
                action={action}
                entityType={entityType}
                user={user}
                page={page}
              />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}

function AuditLogTableSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="flex items-center space-x-4 p-4 border rounded-lg">
          <Skeleton className="h-8 w-8 rounded-full" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}
