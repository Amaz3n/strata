import { Suspense } from "react"

import { PageLayout } from "@/components/layout/page-layout"
import { DivisionRoster, DivisionRosterSkeleton } from "@/components/communities/division-roster"
import { listDivisions } from "@/lib/services/divisions"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

async function DivisionsData() {
  const [divisions, permissions] = await Promise.all([listDivisions(), getCurrentUserPermissions()])
  const canManage = permissions.permissions.some((permission) => ["division.manage", "org.admin", "*"].includes(permission))
  return <DivisionRoster divisions={divisions} canManage={canManage} />
}

export default function DivisionsSettingsPage() {
  return (
    <PageLayout fullBleed title="Divisions" breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Divisions" }]}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <Suspense fallback={<DivisionRosterSkeleton />}>
          <DivisionsData />
        </Suspense>
      </div>
    </PageLayout>
  )
}
