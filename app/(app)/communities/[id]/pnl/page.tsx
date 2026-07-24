import { CommunityPnl } from "@/components/communities/community-pnl"
import { getCommunityPnl } from "@/lib/services/production-reporting"

export const dynamic = "force-dynamic"

export default async function CommunityPnlPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const report = await getCommunityPnl(id)
  return <CommunityPnl report={report} />
}
