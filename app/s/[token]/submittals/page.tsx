import { notFound } from "next/navigation"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadSubmittalsAction } from "./actions"
import { SubmittalsPortalClient } from "./submittals-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubmittalsPortalPage({ params }: Params) {
  const { token } = await params
  try {
    await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_submittals",
    })
  } catch {
    notFound()
  }

  const submittals = await loadSubmittalsAction(token)
  return <SubmittalsPortalClient submittals={submittals} token={token} />
}
