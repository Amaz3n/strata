import { PageLayout } from "@/components/layout/page-layout"
import { listProjectCommitments } from "@/lib/services/commitments"
import { getProjectWaiverRegister } from "@/lib/services/waiver-register"
import { WaiverRegisterClient } from "../../waivers/waiver-register-client"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
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
