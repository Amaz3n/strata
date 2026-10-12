import { connection } from "next/server"
import { Suspense } from "react"

import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { getLeadIntakeSettings } from "@/lib/services/lead-intake"
import { listTeamMembers } from "@/lib/services/team"

import { LeadIntakeSettingsClient } from "./lead-intake-settings-client"

const BREADCRUMBS = [{ label: "Settings", href: "/settings" }, { label: "Lead intake" }]

async function LeadIntakeSettingsContent() {
  await connection()
  const [settings, members] = await Promise.all([
    getLeadIntakeSettings(),
    listTeamMembers(undefined, { includeProjectCounts: false }),
  ])
  const team = members
    .filter((member) => member.status === "active")
    .map((member) => ({ id: member.user.id, name: member.user.full_name || member.user.email }))
  return (
    <PageLayout fullBleed title="Lead intake" breadcrumbs={BREADCRUMBS}>
      <LeadIntakeSettingsClient settings={settings} team={team} />
    </PageLayout>
  )
}

export default function LeadIntakeSettingsPage() {
  return (
    <Suspense fallback={<PageLayout fullBleed title="Lead intake" breadcrumbs={BREADCRUMBS}><PageLoadingSkeleton /></PageLayout>}>
      <LeadIntakeSettingsContent />
    </Suspense>
  )
}
