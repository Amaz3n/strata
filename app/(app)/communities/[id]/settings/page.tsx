import { notFound } from "next/navigation"
import { CommunitySettingsForm } from "@/components/communities/community-settings-form"
import { getCommunity } from "@/lib/services/communities"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export default async function CommunitySettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, divisions, permissions] = await Promise.all([getCommunity(id).catch(() => null), listDivisions().catch(() => []), getCurrentUserPermissions()])
  if (!community) notFound()
  const canWrite = permissions.permissions.some((permission) => ["community.write", "org.admin", "*"].includes(permission))
  return <CommunitySettingsForm community={community} divisions={divisions} canWrite={canWrite} />
}
