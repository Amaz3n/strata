import { connection } from "next/server"
import { unstable_rethrow } from "next/navigation"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { SettingsWindow } from "@/components/settings/settings-window"
import { SettingsSkeleton } from "@/components/settings/settings-skeleton"
import { requireOrgMembership } from "@/lib/auth/context"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { loadSettingsPanel, type SettingsPanelData } from "@/lib/services/settings-page"
import { isSettingsTab } from "@/lib/settings/sections"
import { actionError, type ActionResult } from "@/lib/action-result"

export const instant = true

type SettingsPageProps = { searchParams: Promise<{ tab?: string }> }

async function SettingsData({ searchParams }: SettingsPageProps) {
  await connection()
  const [context, resolved, permissionResult] = await Promise.all([
    requireOrgMembership(),
    searchParams,
    getCurrentUserPermissions(),
  ])
  const tab = isSettingsTab(resolved.tab) ? resolved.tab : "profile"
  let initialPanel: ActionResult<SettingsPanelData>
  try {
    initialPanel = { success: true, data: await loadSettingsPanel(tab, context.orgId) }
  } catch (error) {
    unstable_rethrow(error)
    initialPanel = actionError(error)
  }
  return (
    <SettingsWindow
      key={`${context.orgId}:${context.user.id}`}
      orgId={context.orgId}
      permissions={permissionResult.permissions}
      productTier={context.membership.org_product_tier}
      initialTab={tab}
      initialPanel={initialPanel}
      stripePublishableKey={process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null}
    />
  )
}

export default function SettingsPage(props: SettingsPageProps) {
  return (
    <PageLayout fullBleed>
      <Suspense fallback={<SettingsSkeleton />}>
        <SettingsData {...props} />
      </Suspense>
    </PageLayout>
  )
}
