import { PageLayout } from "@/components/layout/page-layout"
import { PipelineDashboard } from "@/components/pipeline/pipeline-dashboard"
import { listProspects, getCrmDashboardStats, getRecentActivity } from "@/lib/services/crm"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"

export const dynamic = "force-dynamic"

export default async function PipelinePage() {
  const [prospects, stats, teamMembers, permissionResult, recentActivity] = await Promise.all([
    listProspects(),
    getCrmDashboardStats(),
    listTeamMembers(),
    getCurrentUserPermissions(),
    getRecentActivity(undefined, 10),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

  // Filter prospects for dashboard
  const now = new Date()

  const followUpsDue = prospects
    .filter((p) => {
      if (!p.next_follow_up_at) return false
      return p.next_follow_up_at <= new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    })
    .sort((a, b) => {
      if (!a.next_follow_up_at || !b.next_follow_up_at) return 0
      return a.next_follow_up_at.localeCompare(b.next_follow_up_at)
    })

  const newInquiries = prospects
    .filter((p) => p.lead_status === "new" || !p.lead_status)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  // Calculate pipeline counts for chart
  const pipelineCounts = {
    new: prospects.filter((p) => p.lead_status === "new" || !p.lead_status).length,
    contacted: prospects.filter((p) => p.lead_status === "contacted").length,
    qualified: prospects.filter((p) => p.lead_status === "qualified").length,
    estimating: prospects.filter((p) => p.lead_status === "estimating").length,
    won: prospects.filter((p) => p.lead_status === "won").length,
    lost: prospects.filter((p) => p.lead_status === "lost").length,
  }

  // Calculate win rate
  const totalClosed = stats.wonThisMonth + stats.lostThisMonth
  const winRate = totalClosed > 0 ? Math.round((stats.wonThisMonth / totalClosed) * 100) : null

  return (
    <PageLayout title="Pipeline">
      <PipelineDashboard
        stats={stats}
        pipelineCounts={pipelineCounts}
        winRate={winRate}
        followUpsDue={followUpsDue}
        newInquiries={newInquiries}
        recentActivity={recentActivity}
        teamMembers={teamMembers}
        canCreate={canCreate}
        canEdit={canEdit}
      />
    </PageLayout>
  )
}
