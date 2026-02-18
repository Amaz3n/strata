import { Suspense } from "react"
import { redirect } from "next/navigation"
import { PageLayout } from "@/components/layout/page-layout"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AdminStats } from "@/components/admin/admin-stats"
import { QuickActions } from "@/components/admin/quick-actions"
import { getPlans } from "@/lib/services/admin"
import Link from "next/link"

import { getCurrentPlatformAccess, listPlatformOrganizations } from "@/lib/services/platform-access"
import { provisionPlatformOrgAction } from "@/app/(app)/platform/actions"
import { ImpersonationPanel } from "@/components/platform/impersonation-panel"
import { getPlatformSessionState } from "@/lib/services/platform-session"
import { ProvisionOrgSheet } from "@/components/platform/provision-org-sheet"

export const dynamic = "force-dynamic"

export default async function PlatformPage() {
  const access = await getCurrentPlatformAccess()

  if (!access.canAccessPlatform) {
    redirect("/unauthorized")
  }

  const [orgs, session, plans] = await Promise.all([listPlatformOrganizations(), getPlatformSessionState(), getPlans()])

  return (
    <PageLayout
      title="Platform"
      breadcrumbs={[{ label: "Platform" }]}
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-bold">Platform Operations</h1>
            <p className="text-muted-foreground mt-2">Unified admin and platform console for managing client organizations.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ProvisionOrgSheet action={provisionPlatformOrgAction} plans={plans} />
            <Button asChild variant="outline">
              <Link href="/admin/customers">Manage Customers</Link>
            </Button>
            {access.roles.map((role) => (
              <Badge key={role} variant="secondary">{role}</Badge>
            ))}
          </div>
        </div>

        <Suspense fallback={<AdminStatsSkeleton />}>
          <AdminStats />
        </Suspense>

        <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
          <Suspense fallback={<Skeleton className="h-80" />}>
            <QuickActions />
          </Suspense>

          <Card>
            <CardHeader>
              <CardTitle>Impersonation</CardTitle>
              <CardDescription>
                Start an audited impersonation session for support and diagnostics. Active session:
                {" "}
                {session.impersonation.active ? "yes" : "no"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ImpersonationPanel orgs={orgs.map((org) => ({ id: org.id, name: org.name }))} />
            </CardContent>
          </Card>
        </div>

      </div>
    </PageLayout>
  )
}

function AdminStatsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-12" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
