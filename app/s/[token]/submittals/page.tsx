import { notFound } from "next/navigation"
import { validatePortalToken } from "@/lib/services/portal-access"
import { loadSubmittalsAction } from "./actions"
import { SubmittalsPortalClient } from "./submittals-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubmittalsPortalPage({ params }: Params) {
  const { token } = await params
  const access = await validatePortalToken(token)
  if (!access) notFound()

  const submittals = await loadSubmittalsAction(token)
  return <SubmittalsPortalClient submittals={submittals} token={token} />
}

