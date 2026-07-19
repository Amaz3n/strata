import { PageLayout } from "@/components/layout/page-layout"
import { ReleaseBoard } from "@/components/starts/release-board"
import { getReleaseBoard } from "@/lib/services/even-flow"
import { listStartPackageCandidates, listStartPackages } from "@/lib/services/starts"

export const dynamic = "force-dynamic"

export default async function StartsPage() {
  const [board, packages, candidates] = await Promise.all([
    getReleaseBoard(),
    listStartPackages({ status: ["open", "ready", "releasing", "attention"], pageSize: 200 }),
    listStartPackageCandidates(),
  ])
  return <PageLayout title="Starts" fullBleed><div className="p-4"><ReleaseBoard board={board} packages={packages.packages} candidates={candidates} /></div></PageLayout>
}
