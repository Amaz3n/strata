import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { PipelineWorkspaceClient } from "@/components/pipeline/pipeline-workspace-client"
import { listProspects, getRecentActivity } from "@/lib/services/crm"
import { listOpportunities } from "@/lib/services/opportunities"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listContacts } from "@/lib/services/contacts"
import { leadStatusEnum, type LeadStatus } from "@/lib/validation/crm"
import { opportunityStatusEnum, type OpportunityStatus } from "@/lib/validation/opportunities"

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

function resolveOpportunityStatus(status?: string): OpportunityStatus | undefined {
  if (!status) return undefined
  const parsed = opportunityStatusEnum.safeParse(status)
  return parsed.success ? parsed.data : undefined
}

const STALLED_AFTER_DAYS = 14
const NEW_INQUIRY_WINDOW_DAYS = 14
const ACTIVE_OPPORTUNITY_STATUSES = new Set<OpportunityStatus>([
  "new",
  "contacted",
  "qualified",
  "estimating",
  "proposed",
])

async function PipelineData({ searchParams }: PipelinePageProps) {
  const resolvedSearchParams = await searchParams
  const initialView = resolvePipelineView(resolvedSearchParams?.view)
  const initialProspectStatus = resolveLeadStatus(resolvedSearchParams?.status)
  const initialOpportunityStatus = resolveOpportunityStatus(resolvedSearchParams?.status)

  const [prospects, opportunities, teamMembers, permissionResult, recentActivity, clients] = await Promise.all([
    listProspects(),
    listOpportunities(),
    listTeamMembers(),
    getCurrentUserPermissions(),
    getRecentActivity(undefined, 10),
    listContacts(undefined, { contact_type: "client" }),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")
  const canManageProjects = permissions.includes("project.manage")

  const now = new Date()
  const endOfTomorrow = new Date(now)
  endOfTomorrow.setDate(endOfTomorrow.getDate() + 1)
  endOfTomorrow.setHours(23, 59, 59, 999)
  const stalledCutoff = new Date(now.getTime() - STALLED_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const newInquiryCutoff = new Date(now.getTime() - NEW_INQUIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const overdueFollowUps = prospects
    .filter((p) => p.next_follow_up_at && p.next_follow_up_at < now.toISOString())
    .sort((a, b) => (a.next_follow_up_at ?? "").localeCompare(b.next_follow_up_at ?? ""))

  const upcomingFollowUps = prospects
    .filter((p) => {
      if (!p.next_follow_up_at) return false
      return p.next_follow_up_at >= now.toISOString() && p.next_follow_up_at <= endOfTomorrow.toISOString()
    })
    .sort((a, b) => (a.next_follow_up_at ?? "").localeCompare(b.next_follow_up_at ?? ""))

  const newInquiries = prospects
    .filter((p) => (p.lead_status === "new" || !p.lead_status) && p.created_at >= newInquiryCutoff)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  const opportunityCounts: Record<OpportunityStatus, number> = {
    new: 0, contacted: 0, qualified: 0, estimating: 0, proposed: 0, won: 0, lost: 0,
  }
  for (const opportunity of opportunities) {
    opportunityCounts[opportunity.status] += 1
  }

  const stalledOpportunities = opportunities
    .filter((opportunity) => ACTIVE_OPPORTUNITY_STATUSES.has(opportunity.status))
    .filter((opportunity) => (opportunity.updated_at ?? opportunity.created_at) < stalledCutoff)
    .sort((a, b) => (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at))

  return (
    <PipelineWorkspaceClient
      initialView={initialView}
      initialProspectStatus={initialProspectStatus}
      initialOpportunityStatus={initialOpportunityStatus}
      opportunityCounts={opportunityCounts}
      overdueFollowUps={overdueFollowUps}
      upcomingFollowUps={upcomingFollowUps}
      newInquiries={newInquiries}
      stalledOpportunities={stalledOpportunities}
      stalledAfterDays={STALLED_AFTER_DAYS}
      recentActivity={recentActivity}
      prospects={prospects}
      opportunities={opportunities}
      teamMembers={teamMembers}
      clients={clients}
      canCreate={canCreate}
      canEdit={canEdit}
      canManageProjects={canManageProjects}
    />
  )
}

export default function PipelinePage(props: PipelinePageProps) {
  return (
    <PageLayout title="Pipeline">
      <Suspense fallback={
        <div className="p-6 space-y-4">
          <Skeleton className="h-8 w-48 mb-6" />
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
        </div>
      }>
        <PipelineData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
