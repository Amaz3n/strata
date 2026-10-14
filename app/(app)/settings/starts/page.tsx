import { connection } from "next/server"
import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { PageLayout } from "@/components/layout/page-layout"
import { GateSettingsClient } from "@/components/starts/gate-settings-client"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { StartCapacitySettings } from "@/components/starts/start-capacity-settings"
import { getThroughputWeeks } from "@/lib/services/even-flow"
import { listDivisions } from "@/lib/services/divisions"
import { getDivisionAccessForUser } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { getSuperintendentDefaultLimits } from "@/lib/services/superintendent-capacity"
import { listGateDefinitions, listSuperintendentCandidates } from "@/lib/services/starts"
import { addWeeks, mondayOfIsoWeek } from "@/lib/starts/even-flow-math"

/** Weeks the throughput grid offers, from this one. */
const TARGET_WEEKS = 12


async function StartSettingsPageContent() {
  await connection()
  const context = await requireOrgContext()
  const [definitions, permissions, divisions, access, throughput, superintendents, defaultLimits] = await Promise.all([
    listGateDefinitions(), getCurrentUserPermissions(), listDivisions(), getDivisionAccessForUser({ orgId: context.orgId, userId: context.userId }),
    getThroughputWeeks({ weeksBack: 0, weeksAhead: TARGET_WEEKS - 1 }), listSuperintendentCandidates(), getSuperintendentDefaultLimits(),
  ])
  const grants = permissions.permissions
  const isAdmin = grants.includes("*") || grants.includes("org.admin")
  const canManage = isAdmin || grants.includes("start.release")
  const currentWeek = mondayOfIsoWeek(new Date())
  return (
    <PageLayout
      title="Start gate settings"
      breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Start gates" }]}
    >
      <div className="space-y-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          These definitions control every new start package. Auto gates are checked by the system; manual gates are attested per package. Release-produced gates (budget, PO set) are completed by the orchestration ledger.
        </p>
        <GateSettingsClient definitions={definitions} canManage={canManage} />
        <StartCapacitySettings
          weeks={Array.from({ length: TARGET_WEEKS }, (_, index) => addWeeks(currentWeek, index))}
          divisions={divisions.filter((division) => !division.archived && (!access.assignedOnly || access.divisionIds.includes(division.id)))}
          showOrgTarget={!access.assignedOnly}
          throughput={throughput}
          superintendents={superintendents}
          defaultLimits={defaultLimits}
          canSetTargets={isAdmin || grants.includes("start.slots")}
          canSetLimits={canManage}
        />
      </div>
    </PageLayout>
  )
}

export default function StartSettingsPage() {
  return (
    <Suspense fallback={<PageLayout
      title="Start gate settings"
      breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Start gates" }]}
    ><PageLoadingSkeleton /></PageLayout>}>
      <StartSettingsPageContent />
    </Suspense>
  )
}
