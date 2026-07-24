"use client"

import { useMemo, useState } from "react"

import type { TeamMember } from "@/lib/types"
import type { Prospect } from "@/lib/services/prospects"
import { useIsMobile } from "@/hooks/use-mobile"
import { AddProspectDialog } from "@/components/prospects/add-prospect-dialog"
import {
  FUNNEL_STAGE_META,
  PRODUCTION_FUNNEL_STAGE_META,
  PipelineFunnelBar,
  type FunnelStage,
  type PipelineStageKey,
} from "@/components/prospects/prospect-funnel-bar"
import type { AttentionCounts } from "@/components/pipeline/pipeline-attention-strip"
import type {
  PipelineCommunityOption,
  PipelineMode,
  ProspectReservationInfo,
} from "@/components/prospects/prospect-presentation"
import { PipelineMobileWorkspace } from "@/components/prospects/prospect-mobile-workspace"
import { ProspectsClient, type ProspectTableFilter } from "@/components/prospects/prospects-client"

interface PipelineWorkspaceClientProps {
  mode: PipelineMode
  initialFilter: ProspectTableFilter
  initialCommunityId?: string | null
  funnelStages: FunnelStage[]
  attentionCounts: AttentionCounts
  stalledIds: string[]
  followUpDueIds: string[]
  newInquiries: Prospect[]
  prospects: Prospect[]
  teamMembers: TeamMember[]
  communities: PipelineCommunityOption[]
  reservationsByProspect: Record<string, ProspectReservationInfo>
  canCreate?: boolean
  canEdit?: boolean
  canManageSales?: boolean
}

export function PipelineWorkspaceClient({
  mode,
  initialFilter,
  initialCommunityId,
  funnelStages,
  attentionCounts,
  stalledIds,
  followUpDueIds,
  newInquiries,
  prospects,
  teamMembers,
  communities,
  reservationsByProspect,
  canCreate = false,
  canEdit = false,
  canManageSales = false,
}: PipelineWorkspaceClientProps) {
  const isMobile = useIsMobile()
  const [activeFilter, setActiveFilter] = useState<ProspectTableFilter>(initialFilter)
  const [addOpen, setAddOpen] = useState(false)

  const stalledSet = useMemo(() => new Set(stalledIds), [stalledIds])
  const followUpDueSet = useMemo(() => new Set(followUpDueIds), [followUpDueIds])

  if (isMobile) {
    return (
      <PipelineMobileWorkspace
        mode={mode}
        funnelStages={funnelStages}
        attentionCounts={attentionCounts}
        newInquiries={newInquiries}
        prospects={prospects}
        teamMembers={teamMembers}
        communities={communities}
        reservationsByProspect={reservationsByProspect}
        canCreate={canCreate}
      />
    )
  }

  // Selecting the already-active stage/bucket toggles the filter back to the default active view.
  const toggleFilter = (next: ProspectTableFilter) => {
    setActiveFilter((current) => (current === next ? "active" : next))
  }

  const isDefault = activeFilter === "active" || activeFilter === "all"
  const funnelActive = !isDefault && activeFilter !== "stalled" && activeFilter !== "followup_due"
    ? (activeFilter as PipelineStageKey)
    : null

  return (
    <div className="space-y-5">
      <PipelineFunnelBar
        stages={funnelStages}
        meta={mode === "production" ? PRODUCTION_FUNNEL_STAGE_META : FUNNEL_STAGE_META}
        activeStatus={funnelActive}
        onSelect={(status) => toggleFilter(status)}
      />

      <ProspectsClient
        mode={mode}
        prospects={prospects}
        teamMembers={teamMembers}
        communities={communities}
        reservationsByProspect={reservationsByProspect}
        initialCommunityId={initialCommunityId ?? null}
        canCreate={canCreate}
        canEdit={canEdit}
        canManageSales={canManageSales}
        attentionCounts={attentionCounts}
        activeFilter={activeFilter}
        onSelectFilter={setActiveFilter}
        onClearFilter={() => setActiveFilter("active")}
        stalledIds={stalledSet}
        followUpDueIds={followUpDueSet}
        onAddProspect={canCreate ? () => setAddOpen(true) : undefined}
      />

      <AddProspectDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        teamMembers={teamMembers}
        mode={mode}
        communities={communities}
      />
    </div>
  )
}
