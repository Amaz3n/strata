import { connection } from "next/server"
import { notFound } from "next/navigation"

import { CommunitySettingsForm } from "@/components/communities/community-settings-form"
import { CommunityTeam } from "@/components/communities/community-team"
import { CommunityPermitAuthority } from "@/components/permits/community-permit-authority"
import { listCommunityAssignments } from "@/lib/services/community-assignments"
import { getCommunity } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getCommunityPermitAuthority } from "@/lib/services/permits"
import { listTeamMembers } from "@/lib/services/team"


/** Only what you configure once. Phases and takedowns moved to the Land tab. */
export default async function CommunitySettingsPage({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  const { id } = await params
  const [community, divisions, permissions, assignments, members, permitAuthority] = await Promise.all([
    getCommunity(id).catch((error: unknown) => {
      if (error instanceof Error && error.message === "Community not found") return null
      throw error
    }),
    listDivisions(),
    getCurrentUserPermissions(),
    listCommunityAssignments(id),
    listTeamMembers(undefined, { includeProjectCounts: false }),
    getCommunityPermitAuthority(id),
  ])
  if (!community) notFound()
  const canWrite = permissions.permissions.some((permission) =>
    ["community.write", "org.admin", "*"].includes(permission),
  )

  return (
    <div className="max-w-3xl space-y-10 p-4">
      <CommunitySettingsForm community={community} divisions={divisions} canWrite={canWrite} />
      <CommunityPermitAuthority communityId={id} authority={permitAuthority} canWrite={canWrite} />
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
