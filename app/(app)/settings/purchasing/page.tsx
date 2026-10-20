import { guardWorkspaceDesk } from "@/lib/services/workspace-surface"
import { connection } from "next/server"
import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PurchasingSettingsForm } from "@/components/settings/purchasing-settings-form"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getPurchasingSettings, listVarianceReasonCodes } from "@/lib/services/purchasing-settings"

const breadcrumbs = [{ label: "Settings", href: "/settings" }, { label: "Purchasing" }]

async function PurchasingSettingsPageContent() {
  await connection()
  const [, settings, reasons, permissions] = await Promise.all([guardWorkspaceDesk("settings_purchasing"),
    getPurchasingSettings(),
    listVarianceReasonCodes({ includeInactive: true }),
    getCurrentUserPermissions(),
  ])
  const grants = permissions.permissions
  const canWrite = grants.includes("*") || grants.includes("org.admin") || grants.includes("purchasing_settings.write")
  return (
    <PageLayout title="Purchasing settings" breadcrumbs={breadcrumbs}>
      <PurchasingSettingsForm settings={settings} reasons={reasons} canWrite={canWrite} />
    </PageLayout>
  )
}

export default function PurchasingSettingsPage() {
  return (
    <Suspense fallback={<PageLayout title="Purchasing settings" breadcrumbs={breadcrumbs}><PageLoadingSkeleton /></PageLayout>}>
      <PurchasingSettingsPageContent />
    </Suspense>
  )
}
