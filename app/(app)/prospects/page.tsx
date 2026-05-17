import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { ProspectsClient } from "@/components/prospects/prospects-client"
import { listProspects } from "@/lib/services/crm"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = "force-dynamic"

async function ProspectsData() {
  const [prospects, teamMembers, permissionResult] = await Promise.all([
    listProspects(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

  return (
    <div className="space-y-6">
      <ProspectsClient
        prospects={prospects}
        teamMembers={teamMembers}
        canCreate={canCreate}
        canEdit={canEdit}
      />
    </div>
  )
}

export default function ProspectsPage() {
  return (
    <PageLayout title="Prospects">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <ProspectsData />
      </Suspense>
    </PageLayout>
  )
}
