import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { getAuditLogs, getAuditUsers } from "@/lib/services/admin"
import { listPlatformOrganizations } from "@/lib/services/platform-access"
import { AuditLogClient } from "@/components/admin/audit-log-client"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = "force-dynamic"

interface AuditLogContainerProps {
  search: string
  action: string
  entityType: string
  user: string
  orgId: string
  timePeriod: string
  startDate: string
  endDate: string
  page: number
}

async function AuditLogContainer({
  search,
  action,
  entityType,
  user,
  orgId,
  timePeriod,
  startDate,
  endDate,
  page,
}: AuditLogContainerProps) {
  const [logsResult, organizations, users] = await Promise.all([
    getAuditLogs({
      search,
      action: action === "all" ? undefined : action,
      entityType: entityType === "all" ? undefined : entityType,
      user: user === "all" ? undefined : user,
      orgId: orgId === "all" ? undefined : orgId,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      page,
      limit: 50,
    }),
    listPlatformOrganizations(),
    getAuditUsers(),
  ])

  return (
    <AuditLogClient
      auditLogs={logsResult.auditLogs}
      totalCount={logsResult.totalCount}
      hasNextPage={logsResult.hasNextPage}
      hasPrevPage={logsResult.hasPrevPage}
      page={page}
      search={search}
      action={action}
      entityType={entityType}
      user={user}
      orgId={orgId}
      timePeriod={timePeriod}
      startDate={startDate}
      endDate={endDate}
      organizations={organizations.map((org: any) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
      }))}
      users={users}
    />
  )
}

function AuditLogSkeleton() {
  return (
    <div className="p-6 space-y-4 h-full flex flex-col bg-background">
      <div className="flex justify-between items-center mb-4 shrink-0">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          <Skeleton className="h-8 w-60" />
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-8 w-48" />
      </div>
      <div className="flex-1 space-y-2 overflow-hidden">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  await requireAnyPermissionGuard(["audit.read", "platform.support.read"])

  const search = typeof searchParams.search === "string" ? searchParams.search : ""
  const action = typeof searchParams.action === "string" ? searchParams.action : "all"
  const entityType = typeof searchParams.entityType === "string" ? searchParams.entityType : "all"
  const user = typeof searchParams.user === "string" ? searchParams.user : "all"
  const orgId = typeof searchParams.orgId === "string" ? searchParams.orgId : "all"
  const page = typeof searchParams.page === "string" ? parseInt(searchParams.page) : 1

  // Default timePeriod to "7d" if not specified (and no custom start date exists)
  const timePeriod = typeof searchParams.timePeriod === "string" 
    ? searchParams.timePeriod 
    : (searchParams.startDate ? "custom" : "7d")

  let startDate = typeof searchParams.startDate === "string" ? searchParams.startDate : ""
  let endDate = typeof searchParams.endDate === "string" ? searchParams.endDate : ""

  if (timePeriod && timePeriod !== "all" && timePeriod !== "custom" && !startDate) {
    if (timePeriod === "today") {
      const start = new Date()
      start.setHours(0, 0, 0, 0)
      const end = new Date()
      end.setHours(23, 59, 59, 999)
      startDate = start.toISOString()
      endDate = end.toISOString()
    } else if (timePeriod === "7d") {
      const start = new Date()
      start.setDate(start.getDate() - 7)
      startDate = start.toISOString()
    } else if (timePeriod === "30d") {
      const start = new Date()
      start.setDate(start.getDate() - 30)
      startDate = start.toISOString()
    } else if (timePeriod === "90d") {
      const start = new Date()
      start.setDate(start.getDate() - 90)
      startDate = start.toISOString()
    }
  }

  return (
    <PageLayout
      title="Audit Log"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Audit Log" },
      ]}
    >
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<AuditLogSkeleton />}>
          <AuditLogContainer
            search={search}
            action={action}
            entityType={entityType}
            user={user}
            orgId={orgId}
            timePeriod={timePeriod}
            startDate={startDate}
            endDate={endDate}
            page={page}
          />
        </Suspense>
      </div>
    </PageLayout>
  )
}


