import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { SupportContractsTable } from "@/components/admin/support-contracts-table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = 'force-dynamic'

export default async function SupportPage() {
  await requirePermissionGuard("billing.manage")

  return (
    <PageLayout
      title="Support Contracts"
      breadcrumbs={[
        { label: "Admin", href: "/admin" },
        { label: "Support Contracts" }
      ]}
    >
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold">Support Contracts</h1>
          <p className="text-muted-foreground mt-2">
            Manage customer support agreements and contracts
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Support Agreements</CardTitle>
            <CardDescription>
              View and manage support contracts for all customers
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SupportTableSkeleton />}>
              <SupportContractsTable />
            </Suspense>
          </CardContent>
        </Card>
      </div>
    </PageLayout>
  )
}

function SupportTableSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center space-x-4 p-4 border rounded-lg">
          <Skeleton className="h-12 w-12 rounded" />
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-32" />
          </div>
          <Skeleton className="h-6 w-16" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  )
}