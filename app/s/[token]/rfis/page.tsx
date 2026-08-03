import { notFound } from "next/navigation"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { loadRfisAction } from "./actions"
import { AskQuestionButton } from "./ask-question-dialog"
import { RfisPortalClient } from "./rfis-client"

interface Params {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function RfisPortalPage({ params }: Params) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireCompany: true,
      permission: "can_view_rfis",
    })
  } catch {
    notFound()
  }

  const rfis = await loadRfisAction(token)
  const canRespond = access.permissions.can_respond_rfis !== false
  const scoped = !!access.scoped_rfi_id

  return (
    <>
      <PortalPageHeader
        title="RFIs"
        description="Questions the builder has sent you, and any you need to ask them."
        actions={canRespond && !scoped ? <AskQuestionButton token={token} /> : undefined}
      />
      <RfisPortalClient
        rfis={rfis}
        token={token}
        companyId={access.company_id ?? null}
        canRespond={canRespond}
        canDownload={access.permissions.can_download_files !== false}
        scoped={scoped}
      />
    </>
  )
}
