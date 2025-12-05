import { notFound } from "next/navigation"
import { validatePortalToken } from "@/lib/services/portal-access"
import { loadRfisAction } from "./actions"
import { RfisPortalClient } from "./rfis-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function RfisPortalPage({ params }: Params) {
  const { token } = await params
  const access = await validatePortalToken(token)
  if (!access) notFound()

  const rfis = await loadRfisAction(token)
  return <RfisPortalClient rfis={rfis} token={token} />
}

