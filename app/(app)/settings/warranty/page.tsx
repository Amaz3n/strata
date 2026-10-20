import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { getOrgProductTier } from "@/lib/services/context"
import { getProjectPosture } from "@/lib/product-tier"
import { listWarrantyPrograms, listWarrantySlaTargets } from "@/lib/services/warranty"

import { WarrantySettingsClient } from "./warranty-settings-client"


async function WarrantySettingsPageContent() {
  await connection()
  const [, programs, targets, productTier] = await Promise.all([guardWorkspaceDesk("settings_warranty"),
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

export default function WarrantySettingsPage() {
  return (
    <Suspense fallback={<PageLayout fullBleed title="Warranty" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Warranty" }]}><PageLoadingSkeleton /></PageLayout>}>
      <WarrantySettingsPageContent />
    </Suspense>
  )
}
