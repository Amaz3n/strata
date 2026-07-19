import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
export const dynamic = 'force-dynamic'
import { TEAM_PERMISSION_OPTIONS, listAssignableOrgRoles, listTeamMembers } from "@/lib/services/team"
import { TeamPageClient } from "@/components/team/team-page-client"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { Skeleton } from "@/components/ui/skeleton"
import { listDivisions } from "@/lib/services/divisions"

async function TeamData() {
  const [members, permissionResult, roleOptions, divisions] = await Promise.all([
    listTeamMembers(),
    getCurrentUserPermissions(),
    listAssignableOrgRoles().catch(() => []),
    listDivisions().catch(() => []),
  ])

  const canManageMembers = permissionResult.permissions.includes("members.manage")
  const canEditRoles = permissionResult.permissions.includes("org.admin")

  return (
    <TeamPageClient
      members={members}
      canManageMembers={canManageMembers}
      canEditRoles={canEditRoles}
      roleOptions={roleOptions}
      permissionOptions={TEAM_PERMISSION_OPTIONS}
      divisions={divisions}
    />
  )
}

export default function TeamPage() {
  return (
    <PageLayout title="Team">
      <Suspense fallback={<div className="p-6 space-y-4"><Skeleton className="h-8 w-48 mb-6" /><div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-16 w-full rounded-md" />))}</div></div>}>
        <TeamData />
      </Suspense>
    </PageLayout>
  )
}
