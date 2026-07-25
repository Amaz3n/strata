import { PageLayout } from "@/components/layout/page-layout"
import { getOrgProductTier } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"
import { listWarrantyPrograms, listWarrantySlaTargets } from "@/lib/services/warranty"

import { WarrantySettingsClient } from "./warranty-settings-client"

export const dynamic = "force-dynamic"

export default async function WarrantySettingsPage() {
  const [programs, targets, productTier] = await Promise.all([
    listWarrantyPrograms(),
    listWarrantySlaTargets(),
    getOrgProductTier(),
  ])

  return (
    <PageLayout fullBleed title="Warranty" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Warranty" }]}>
      <WarrantySettingsClient
        programs={programs}
        targets={targets}
        posture={getProjectPosture(null, productTier)}
      />
    </PageLayout>
  )
}
