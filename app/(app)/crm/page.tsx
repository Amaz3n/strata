import { PageLayout } from "@/components/layout/page-layout"
import { CrmDashboard } from "@/components/crm"
import { listProspects, getCrmDashboardStats } from "@/lib/services/crm"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function CrmPage() {
  const [prospects, stats, teamMembers, permissionResult] = await Promise.all([
    listProspects(),
    getCrmDashboardStats(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

  // Filter prospects for dashboard
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()

  const followUpsDue = prospects.filter((p) => {
    if (!p.next_follow_up_at) return false
    return p.next_follow_up_at <= new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  }).sort((a, b) => {
    if (!a.next_follow_up_at || !b.next_follow_up_at) return 0
    return a.next_follow_up_at.localeCompare(b.next_follow_up_at)
  })

  const newInquiries = prospects.filter((p) => p.lead_status === "new" || !p.lead_status).sort((a, b) => {
    return b.created_at.localeCompare(a.created_at)
  })

  return (
    <PageLayout title="CRM">
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">CRM Dashboard</h1>
          <p className="text-muted-foreground">Track and manage your sales pipeline</p>
        </div>
        <CrmDashboard
          stats={stats}
          followUpsDue={followUpsDue}
          newInquiries={newInquiries}
          teamMembers={teamMembers}
          canCreate={canCreate}
          canEdit={canEdit}
        />
      </div>
    </PageLayout>
  )
}
