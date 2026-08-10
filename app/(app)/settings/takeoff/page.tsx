import { PageLayout } from "@/components/layout/page-layout"
import { TakeoffTemplatesPanel } from "@/components/settings/takeoff-templates-panel"
import { unwrapAction } from "@/lib/action-result"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { groupTemplates } from "@/lib/services/takeoff-templates"
import { TEMPLATE_LIST_CAP } from "@/lib/validation/takeoff"
import {
  listConditionTemplatesAction,
  listTakeoffCostCodesAction,
  listTemplateGroupsAction,
} from "@/app/(app)/drawings/takeoff-actions"

export const dynamic = "force-dynamic"

export default async function TakeoffSettingsPage() {
  const [templatesResult, groupsResult, costCodes, permissionResult] = await Promise.all([
    listConditionTemplatesAction(),
    listTemplateGroupsAction(),
    listTakeoffCostCodesAction(),
    getCurrentUserPermissions(),
  ])

  const templates = unwrapAction(templatesResult)
  const groups = unwrapAction(groupsResult)
  const permissions = permissionResult.permissions
  const canManage =
    permissions.includes("*") ||
    permissions.includes("org.admin") ||
    permissions.includes("takeoff.write")

  return (
    <PageLayout
      fullBleed
      title="Takeoff"
      breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Takeoff" }]}
    >
      <TakeoffTemplatesPanel
        groups={groupTemplates(templates)}
        groupNames={groups}
        costCodes={costCodes}
        total={templates.length}
        cap={TEMPLATE_LIST_CAP}
        canManage={canManage}
      />
    </PageLayout>
  )
}
