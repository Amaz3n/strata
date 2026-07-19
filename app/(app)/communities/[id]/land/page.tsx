import { notFound } from "next/navigation"
import { LandTab } from "@/components/communities/land-tab"
import { getCommunity } from "@/lib/services/communities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export default async function CommunityLandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, permissions] = await Promise.all([getCommunity(id).catch(() => null), getCurrentUserPermissions()])
  if (!community) notFound()
  const canWrite = permissions.permissions.some((permission) => ["community.write", "org.admin", "*"].includes(permission))
  return <LandTab community={community} canWrite={canWrite} />
}
