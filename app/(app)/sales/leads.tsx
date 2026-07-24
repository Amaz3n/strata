import type { FunnelStage } from "@/components/prospects/prospect-funnel-bar"
import type { AttentionCounts } from "@/components/pipeline/pipeline-attention-strip"
import type {
  PipelineCommunityOption,
  ProspectReservationInfo,
} from "@/components/prospects/prospect-presentation"
import { PipelineWorkspaceClient } from "@/components/prospects/prospect-workspace-client"
import type { ProspectTableFilter } from "@/components/prospects/prospects-client"
import { listProspectReservations } from "@/lib/services/community-sales"
import { listCommunities } from "@/lib/services/communities"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { listProspects } from "@/lib/services/prospects"
import { listTeamMembers } from "@/lib/services/team"
import { prospectStatusEnum, type ProspectStatus } from "@/lib/validation/prospects"

const PRODUCTION_NURTURE: ProspectStatus[] = ["new", "contacted", "qualified"]
const ACTIVE_PROSPECT_STATUSES = new Set<ProspectStatus>([
  "new",
  "contacted",
  "qualified",
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
  "executed",
])
const STALLED_AFTER_DAYS = 14
const NEW_INQUIRY_WINDOW_DAYS = 14

function resolveInitialFilter(status?: string): ProspectTableFilter {
  if (status === "stalled" || status === "followup_due" || status === "all") return status
  if (status === "reserved" || status === "converted") return status
  if (!status) return "active"
  const parsed = prospectStatusEnum.safeParse(status)
  return parsed.success ? parsed.data : "active"
}

export async function SalesLeads({
  status,
  communityId,
}: {
  status?: string
  communityId?: string
}) {
  const [prospects, teamMembers, permissionResult] = await Promise.all([
    listProspects(),
    listTeamMembers(),
    getCurrentUserPermissions(),
  ])
  const permissions = permissionResult.permissions
  const canReadSales = permissions.includes("sales.read") || permissions.includes("org.admin") || permissions.includes("*")
  const canManageSales = permissions.includes("sales.manage") || permissions.includes("org.admin") || permissions.includes("*")
  const canEdit = permissions.includes("org.member") || permissions.includes("org.admin") || permissions.includes("*")

  const [communityRows, reservations] = canReadSales
    ? await Promise.all([
        permissions.includes("community.read") || permissions.includes("org.admin") || permissions.includes("*")
          ? listCommunities()
          : Promise.resolve([]),
        listProspectReservations(),
      ])
    : [[], []]

  const communities: PipelineCommunityOption[] = communityRows.map(({ id, name }) => ({ id, name }))
  const reservationsByProspect: Record<string, ProspectReservationInfo> = {}
  for (const reservation of reservations) {
    if (!reservationsByProspect[reservation.prospectId]) {
      reservationsByProspect[reservation.prospectId] = {
        status: reservation.status,
        askingPriceCents: reservation.askingPriceCents,
        communityName: reservation.communityName,
        lotLabel: reservation.lotLabel,
        expiresAt: reservation.expiresAt,
      }
    }
  }

  const now = new Date()
  const stalledCutoff = new Date(now.getTime() - STALLED_AFTER_DAYS * 86_400_000).toISOString()
  const newInquiryCutoff = new Date(now.getTime() - NEW_INQUIRY_WINDOW_DAYS * 86_400_000).toISOString()
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)
  const endOfTodayIso = endOfToday.toISOString()
  const hasReservation = (prospectId: string) => Boolean(reservationsByProspect[prospectId])

  const newInquiries = prospects
    .filter((prospect) => prospect.status === "new" && prospect.created_at >= newInquiryCutoff)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
  const stalledProspects = prospects
    .filter((prospect) => ACTIVE_PROSPECT_STATUSES.has(prospect.status))
    .filter((prospect) => !hasReservation(prospect.id))
    .filter((prospect) => (prospect.updated_at ?? prospect.created_at) < stalledCutoff)
  const followUpDueProspects = prospects
    .filter((prospect) => ACTIVE_PROSPECT_STATUSES.has(prospect.status))
    .filter((prospect) => prospect.next_follow_up_at && prospect.next_follow_up_at <= endOfTodayIso)

  const nurtureStages: FunnelStage[] = PRODUCTION_NURTURE.map((key) => {
    const stageProspects = prospects.filter((prospect) => prospect.status === key && !hasReservation(prospect.id))
    return { key, count: stageProspects.length, valueCents: 0 }
  })
  const reservationEntries = Object.values(reservationsByProspect)
  const reserved = reservationEntries.filter((entry) => entry.status === "hold" || entry.status === "reserved")
  const converted = reservationEntries.filter((entry) => entry.status === "converted")
  const funnelStages: FunnelStage[] = [
    ...nurtureStages,
    {
      key: "reserved",
      count: reserved.length,
      valueCents: reserved.reduce((sum, entry) => sum + entry.askingPriceCents, 0),
    },
    {
      key: "converted",
      count: converted.length,
      valueCents: converted.reduce((sum, entry) => sum + entry.askingPriceCents, 0),
    },
  ]
  const attentionCounts: AttentionCounts = {
    followup_due: followUpDueProspects.length,
    stalled: stalledProspects.length,
    estimate_sent: 0,
    changes_requested: 0,
    client_approved: 0,
    executed: 0,
  }

  return (
    <div className="p-4">
      <PipelineWorkspaceClient
        mode="production"
        initialFilter={resolveInitialFilter(status)}
        initialCommunityId={communityId ?? null}
        funnelStages={funnelStages}
        attentionCounts={attentionCounts}
        stalledIds={stalledProspects.map(({ id }) => id)}
        followUpDueIds={followUpDueProspects.map(({ id }) => id)}
        newInquiries={newInquiries}
        prospects={prospects}
        teamMembers={teamMembers}
        communities={communities}
        reservationsByProspect={reservationsByProspect}
        canCreate={canEdit}
        canEdit={canEdit}
        canManageSales={canManageSales}
      />
    </div>
  )
}
