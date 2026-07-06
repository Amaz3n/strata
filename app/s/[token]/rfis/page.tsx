import { notFound } from "next/navigation"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadRfisAction } from "./actions"
import { RfisPortalClient } from "./rfis-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function RfisPortalPage({ params }: Params) {
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_rfis",
    })
  } catch {
    notFound()
  }

  const rfis = await loadRfisAction(token)
  return <RfisPortalClient rfis={rfis} token={token} />
}
