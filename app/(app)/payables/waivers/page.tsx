import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { getProjectWaiverRegister } from "@/lib/services/waiver-register"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { WaiverRegisterClient } from "@/app/(app)/projects/[id]/financials/waivers/waiver-register-client"
import { listProjects } from "@/lib/services/projects"
async function PageContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const q = await searchParams,
    scope = await resolveProductionDeskScope({ communityId: q.community })
  const ids = (await listProjects())
    .map((p) => p.id)
    .filter((id) => !scope.projectIds || scope.projectIds.includes(id))
  const register = await getProjectWaiverRegister(
    "",
    q.periodEnd ?? "",
    undefined,
    {
      projectIds: ids,
      page: Number(q.page) || 1,
      search: q.q,
      status: q.status ?? "outstanding",
    },
  )
  return (
    <PageLayout title="Payables · Waivers" fullBleed>
      <WaiverRegisterClient register={register} commitments={[]} />
    </PageLayout>
  )
}

export default function Page(props: Parameters<typeof PageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PageContent {...props} />
    </Suspense>
  )
}
