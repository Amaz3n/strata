import { connection } from "next/server"
import { notFound } from "next/navigation"

import { ReleasedOptions, ReleasedScope, ReleasedSheets, ReleasedTruncationNote } from "@/components/field/released-documents"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { getReleasedForTrade } from "@/lib/services/released-field-documents"

interface Props {
  params: Promise<{ token: string }>
}

export default async function SubPortalReleasedPage({ params }: Props) {
  await connection()
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, {
      portalType: "sub",
      requireProject: true,
      requireCompany: true,
      permission: "can_view_documents",
    })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const released = await getReleasedForTrade({
    orgId: access.org_id,
    projectId: access.project_id,
    companyId: access.company_id,
  })

  return (
    <>
      <PortalPageHeader
        title="Released for this home"
        description="The drawings released to you, the options confirmed for this home and the scope you were awarded on this home. Build only from current drawings."
      />
      <div className="border border-border bg-card">
        {released.truncated && <ReleasedTruncationNote />}
        <ReleasedSheets
          hint="No drawings have been released to you for this home yet."
          sheets={released.sheets}
        />
        <ReleasedOptions options={released.options} />
        <ReleasedScope scope={released.scope} showCompany={false} />
      </div>
    </>
  )
}
