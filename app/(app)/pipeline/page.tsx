import { Suspense } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { PageLayout } from "@/components/layout/page-layout"
import { PipelineWorkspaceClient } from "@/components/pipeline/pipeline-workspace-client"
import type { FunnelStage } from "@/components/pipeline/pipeline-funnel-bar"
import type { AttentionCounts } from "@/components/pipeline/pipeline-attention-strip"
import type { ProspectTableFilter } from "@/components/prospects/prospects-client"
import { listProspects } from "@/lib/services/prospects"
import { listTeamMembers } from "@/lib/services/team"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { prospectStatusEnum, type ProspectStatus } from "@/lib/validation/prospects"

export const dynamic = "force-dynamic"

interface PipelinePageProps {
  searchParams: Promise<{
    status?: string
  }>
}

const FUNNEL_STAGES: ProspectStatus[] = ["new", "contacted", "qualified", "pricing", "estimate_sent"]

const STALLED_AFTER_DAYS = 14
const NEW_INQUIRY_WINDOW_DAYS = 14
const ACTIVE_PROSPECT_STATUSES = new Set<ProspectStatus>([
  "new",
  "contacted",
  "qualified",
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
])

function resolveInitialFilter(status?: string): ProspectTableFilter {
  if (status === "stalled") return "stalled"
  if (status === "followup_due") return "followup_due"
  if (status === "all") return "all"
  if (!status) return "active"
  const parsed = prospectStatusEnum.safeParse(status)
  return parsed.success ? parsed.data : "active"
}

async function PipelineData({ searchParams }: PipelinePageProps) {
  const resolvedSearchParams = await searchParams
  const initialFilter = resolveInitialFilter(resolvedSearchParams?.status)

  const [prospects, teamMembers, permissionResult] = await Promise.all([
    listProspects(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member")
  const canCreate = permissions.includes("org.member")

  const now = new Date()
  const stalledCutoff = new Date(now.getTime() - STALLED_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const newInquiryCutoff = new Date(now.getTime() - NEW_INQUIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const newInquiries = prospects
    .filter((p) => p.status === "new" && p.created_at >= newInquiryCutoff)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))

  const stalledProspects = prospects
    .filter((prospect) => ACTIVE_PROSPECT_STATUSES.has(prospect.status))
    .filter((prospect) => (prospect.updated_at ?? prospect.created_at) < stalledCutoff)
  const stalledIds = stalledProspects.map((p) => p.id)

  // Follow-ups due = active prospect with a scheduled follow-up at or before the end of today.
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString()
  const followUpDueProspects = prospects
    .filter((prospect) => ACTIVE_PROSPECT_STATUSES.has(prospect.status))
    .filter((prospect) => prospect.next_follow_up_at && prospect.next_follow_up_at <= endOfToday)
  const followUpDueIds = followUpDueProspects.map((p) => p.id)

  const funnelStages: FunnelStage[] = FUNNEL_STAGES.map((key) => {
    const stageProspects = prospects.filter((p) => p.status === key)
    return {
      key,
      count: stageProspects.length,
      valueCents: stageProspects.reduce((sum, p) => sum + (p.estimate_value_cents ?? 0), 0),
    }
  })

  const countByStatus = (status: ProspectStatus) => prospects.filter((p) => p.status === status).length
  const attentionCounts: AttentionCounts = {
    followup_due: followUpDueProspects.length,
    stalled: stalledProspects.length,
    estimate_sent: countByStatus("estimate_sent"),
    changes_requested: countByStatus("changes_requested"),
    client_approved: countByStatus("client_approved"),
    executed: countByStatus("executed"),
  }

  return (
    <PipelineWorkspaceClient
      initialFilter={initialFilter}
      funnelStages={funnelStages}
      attentionCounts={attentionCounts}
      stalledIds={stalledIds}
      followUpDueIds={followUpDueIds}
      newInquiries={newInquiries}
      prospects={prospects}
      teamMembers={teamMembers}
      canCreate={canCreate}
      canEdit={canEdit}
    />
  )
}

export default function PipelinePage(props: PipelinePageProps) {
  return (
    <PageLayout title="Pipeline">
      <Suspense
        fallback={
          <div className="space-y-4 p-6">
            <Skeleton className="mb-6 h-8 w-48" />
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-md" />
              ))}
            </div>
          </div>
        }
      >
        <PipelineData searchParams={props.searchParams} />
      </Suspense>
    </PageLayout>
  )
}
