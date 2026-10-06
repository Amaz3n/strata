import { connection } from "next/server"
import { Suspense } from "react"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { listProjectCommitments } from "@/lib/services/commitments"
import { getProjectWaiverRegister } from "@/lib/services/waiver-register"
import { WaiverRegisterClient } from "../../waivers/waiver-register-client"
async function PageContent({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  await connection()
  const [{ id }, q] = await Promise.all([params, searchParams])
  const [register, commitments] = await Promise.all([
    getProjectWaiverRegister(id, q.periodEnd ?? "", undefined, {
      page: Number(q.page) || 1,
      search: q.q,
      status: q.status ?? "outstanding",
    }),
    listProjectCommitments(id),
  ])
  return (
    <PageLayout title="Payables · Waivers" fullBleed>
      <WaiverRegisterClient
        projectId={id}
        register={register}
        commitments={commitments}
      />
    </PageLayout>
  )
}

export default function Page(props: Parameters<typeof PageContent>[0]) {
  return (
    <Suspense
      fallback={
        <PageLayout title="Payables · Waivers" fullBleed>
          <PageLoadingSkeleton />
        </PageLayout>
      }
    >
      <PageContent {...props} />
    </Suspense>
  )
}
