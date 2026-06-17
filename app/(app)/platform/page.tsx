import { Suspense } from "react"
import { redirect } from "next/navigation"

import { PageLayout } from "@/components/layout/page-layout"
import { Skeleton } from "@/components/ui/skeleton"
import { PlatformClient } from "@/components/platform/platform-client"

import { listOrgAiSearchAccess } from "@/lib/services/ai-search-access"
import { getAdminStats, getPlans } from "@/lib/services/admin"
import { getCurrentPlatformAccess, listPlatformOrganizations } from "@/lib/services/platform-access"
import { getPlatformSessionState } from "@/lib/services/platform-session"
import { getPlatformAiFeatureDefaultConfig } from "@/lib/services/ai-config"
import { getDemoUsageSummary } from "@/lib/services/platform-demo-usage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { hasAnyPermission } from "@/lib/services/permissions"
import { requireAuth } from "@/lib/auth/context"

export const dynamic = "force-dynamic"

async function PlatformData() {
  const access = await getCurrentPlatformAccess()
  if (!access.canAccessPlatform) {
    redirect("/unauthorized")
  }

  const { user } = await requireAuth()
  const serviceSupabase = createServiceSupabaseClient()

  const [stats, orgs, session, plans, aiConfigs, canManagePlatformAi, aiSearchAccess, demoUsage] = await Promise.all([
    getAdminStats(),
    listPlatformOrganizations(),
    getPlatformSessionState(),
    getPlans(),
    Promise.all([
      getPlatformAiFeatureDefaultConfig({ supabase: serviceSupabase, feature: "search" }),
      getPlatformAiFeatureDefaultConfig({ supabase: serviceSupabase, feature: "document_extraction" }),
      getPlatformAiFeatureDefaultConfig({ supabase: serviceSupabase, feature: "drawings_vision" }),
    ]),
    hasAnyPermission(["platform.feature_flags.manage", "billing.manage"], { userId: user.id }),
    listOrgAiSearchAccess(),
    getDemoUsageSummary(),
  ])

  return (
    <PlatformClient
      roles={access.roles}
      stats={{
        totalOrgs: stats.totalOrgs,
        newOrgsThisMonth: stats.newOrgsThisMonth,
        activeSubscriptions: stats.activeSubscriptions,
        trialingSubscriptions: stats.trialingSubscriptions,
      }}
      plans={plans}
      orgs={orgs.map((org) => ({ id: org.id, name: org.name }))}
      aiConfigs={aiConfigs}
      aiSearchAccess={aiSearchAccess}
      canManagePlatformAi={canManagePlatformAi}
      demoUsage={demoUsage}
      impersonation={{
        active: session.impersonation.active,
        target: session.impersonation.targetName ?? session.impersonation.targetEmail,
        expiresAt: session.impersonation.expiresAt,
      }}
    />
  )
}

export default function PlatformPage() {
  return (
    <PageLayout title="Platform">
      <div className="-m-4 -mt-6 h-[calc(100vh-3.5rem)]">
        <Suspense fallback={<PlatformSkeleton />}>
          <PlatformData />
        </Suspense>
      </div>
    </PageLayout>
  )
}

function PlatformSkeleton() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-8 w-64" />
      </div>
      <div className="mx-auto w-full max-w-4xl space-y-8 px-6 py-8">
        <Skeleton className="h-24 w-full rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  )
}
