import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { DailyLogsClient } from "./daily-logs-client"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalDailyLogsPage({ params }: Props) {
  const { token } = await params

  try {
    await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_submit_daily_logs",
    })
  } catch {
    notFound()
  }

  return (
    <>
      <PortalPageHeader
        title="Daily logs"
        description="Submit your company's manpower, narrative, and site photo. The builder's own report stays private."
      />
      <DailyLogsClient token={token} />
    </>
  )
}
