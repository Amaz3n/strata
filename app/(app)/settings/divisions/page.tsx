import { DivisionTable } from "@/components/communities/division-table"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function DivisionsSettingsPage() {
  const [divisions, permissions] = await Promise.all([listDivisions(), getCurrentUserPermissions()])
  const canManage = permissions.permissions.some((permission) => ["division.manage", "org.admin", "*"].includes(permission))
  return <DivisionTable divisions={divisions} canManage={canManage} />
}
