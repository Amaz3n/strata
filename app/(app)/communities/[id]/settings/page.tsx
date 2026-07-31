import { notFound } from "next/navigation"

import { CommunitySettingsForm } from "@/components/communities/community-settings-form"
import { CommunityTeam } from "@/components/communities/community-team"
import { listCommunityAssignments } from "@/lib/services/community-assignments"
import { getCommunity } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listTeamMembers } from "@/lib/services/team"

export const dynamic = "force-dynamic"

/** Only what you configure once. Phases and takedowns moved to the Land tab. */
export default async function CommunitySettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, divisions, permissions, assignments, members] = await Promise.all([
    getCommunity(id).catch(() => null),
    listDivisions().catch(() => []),
    getCurrentUserPermissions(),
    listCommunityAssignments(id).catch(() => []),
    listTeamMembers(undefined, { includeProjectCounts: false }).catch(() => []),
  ])
  if (!community) notFound()
  const canWrite = permissions.permissions.some((permission) =>
    ["community.write", "org.admin", "*"].includes(permission),
  )

  return (
    <div className="max-w-3xl space-y-10 p-4">
      <CommunitySettingsForm community={community} divisions={divisions} canWrite={canWrite} />
      <CommunityTeam
        communityId={id}
        assignments={assignments}
        members={members
          .filter((member) => member.status === "active")
          .map((member) => ({ id: member.user.id, name: member.user.full_name ?? member.user.email ?? "Unknown" }))}
        canWrite={canWrite}
      />
    </div>
  )
}
