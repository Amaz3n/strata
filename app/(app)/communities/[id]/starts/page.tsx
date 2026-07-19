import { notFound } from "next/navigation"

import { ReleaseBoard } from "@/components/starts/release-board"
import { getCommunity } from "@/lib/services/communities"
import { getReleaseBoard } from "@/lib/services/even-flow"
import { listStartPackageCandidates, listStartPackages } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function CommunityStartsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [community, board, packages, allCandidates] = await Promise.all([
    getCommunity(id).catch(() => null),
    getReleaseBoard({ communityId: id }),
    listStartPackages({ communityId: id, status: ["open", "ready", "releasing", "attention"], pageSize: 200 }),
    listStartPackageCandidates(),
  ])
  if (!community) notFound()
  return <div className="p-4"><ReleaseBoard board={board} packages={packages.packages} candidates={allCandidates.filter((candidate) => candidate.communityId === id)} /></div>
}
