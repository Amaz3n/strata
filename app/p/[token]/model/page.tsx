import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { Plan3dViewerPanel } from "@/components/portal/tabs/portal-model-tab"
import { getPortalFloorplanModel } from "@/lib/services/floorplan-models"
import { assertPortalActionAccess } from "@/lib/services/portal-access"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

/**
 * A buyer walking their own house before it exists.
 *
 * Read-only by construction: the buyer portal never sees a correction
 * affordance, and the document it renders is the PUBLISHED model — the one a
 * human reviewed against the plan sheets and signed off. What a buyer walks
 * through is a claim the builder made on purpose.
 */
export default async function ClientPortalModelPage({ params }: Props) {
  const { token } = await params
  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "client" })
  } catch {
    notFound()
  }

  const floorplan = await getPortalFloorplanModel({
    orgId: access.org_id,
    projectId: access.project_id,
  })
  if (!floorplan) notFound()

  return (
    <>
      <PortalPageHeader
        title="Your home in 3D"
        description={`${floorplan.planLabel} · ${floorplan.floorAreaSqft.toLocaleString("en-US")} SF · ${floorplan.levelCount} ${floorplan.levelCount === 1 ? "level" : "levels"}`}
      />
      <Plan3dViewerPanel model={floorplan.model} planLabel={floorplan.planLabel} />
    </>
  )
}
