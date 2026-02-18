import { PageLayout } from "@/components/layout/page-layout"
import { PipelineWorkspaceClient } from "@/components/pipeline/pipeline-workspace-client"
import { listProspects, getCrmDashboardStats, getRecentActivity } from "@/lib/services/crm"
import { listOpportunities } from "@/lib/services/opportunities"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listContacts } from "@/lib/services/contacts"
import { leadStatusEnum, type LeadStatus } from "@/lib/validation/crm"

export const dynamic = "force-dynamic"

type PipelineView = "overview" | "opportunities" | "prospects"

interface PipelinePageProps {
  searchParams: Promise<{
    view?: string
    status?: string
  }>
}

function resolvePipelineView(view?: string): PipelineView {
  if (view === "opportunities" || view === "prospects") return view
  return "overview"
}

function resolveLeadStatus(status?: string): LeadStatus | undefined {
  if (!status) return undefined
  const parsed = leadStatusEnum.safeParse(status)
  return parsed.success ? parsed.data : undefined
}

export default async function PipelinePage({ searchParams }: PipelinePageProps) {
  const resolvedSearchParams = await searchParams
  const initialView = resolvePipelineView(resolvedSearchParams?.view)
  const initialProspectStatus = resolveLeadStatus(resolvedSearchParams?.status)

  const [prospects, opportunities, stats, teamMembers, permissionResult, recentActivity, clients] = await Promise.all([
    listProspects(),
    listOpportunities(),
    getCrmDashboardStats(),
    listTeamMembers(),
    getCurrentUserPermissions(),
    getRecentActivity(undefined, 10),
    listContacts(undefined, { contact_type: "client" }),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

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

  const pipelineCounts = {
    new: prospects.filter((p) => p.lead_status === "new" || !p.lead_status).length,
    contacted: prospects.filter((p) => p.lead_status === "contacted").length,
    qualified: prospects.filter((p) => p.lead_status === "qualified").length,
    estimating: prospects.filter((p) => p.lead_status === "estimating").length,
    won: prospects.filter((p) => p.lead_status === "won").length,
    lost: prospects.filter((p) => p.lead_status === "lost").length,
  }

  const totalClosed = stats.wonThisMonth + stats.lostThisMonth
  const winRate = totalClosed > 0 ? Math.round((stats.wonThisMonth / totalClosed) * 100) : null

  return (
    <PageLayout title="Pipeline">
      <PipelineWorkspaceClient
        initialView={initialView}
        initialProspectStatus={initialProspectStatus}
        stats={stats}
        pipelineCounts={pipelineCounts}
        winRate={winRate}
        followUpsDue={followUpsDue}
        newInquiries={newInquiries}
        recentActivity={recentActivity}
        prospects={prospects}
        opportunities={opportunities}
        teamMembers={teamMembers}
        clients={clients}
        canCreate={canCreate}
        canEdit={canEdit}
      />
    </PageLayout>
  )
}
