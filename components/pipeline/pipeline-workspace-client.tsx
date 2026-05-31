"use client"

import { useMemo, useState } from "react"

import type { TeamMember } from "@/lib/types"
import type { Prospect } from "@/lib/services/prospects"
import type { ProspectStatus } from "@/lib/validation/prospects"
import { useIsMobile } from "@/hooks/use-mobile"
import { AddProspectDialog } from "@/components/pipeline/add-prospect-dialog"
import { PipelineFunnelBar, type FunnelStage } from "@/components/pipeline/pipeline-funnel-bar"
import type { AttentionCounts } from "@/components/pipeline/pipeline-attention-strip"
import { PipelineMobileWorkspace } from "@/components/pipeline/pipeline-mobile-workspace"
import { ProspectsClient, type ProspectTableFilter } from "@/components/prospects/prospects-client"

interface PipelineWorkspaceClientProps {
  initialFilter: ProspectTableFilter
  funnelStages: FunnelStage[]
  attentionCounts: AttentionCounts
  stalledIds: string[]
  followUpDueIds: string[]
  newInquiries: Prospect[]
  prospects: Prospect[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
}

export function PipelineWorkspaceClient({
  initialFilter,
  funnelStages,
  attentionCounts,
  stalledIds,
  followUpDueIds,
  newInquiries,
  prospects,
  teamMembers,
  canCreate = false,
  canEdit = false,
}: PipelineWorkspaceClientProps) {
  const isMobile = useIsMobile()
  const [activeFilter, setActiveFilter] = useState<ProspectTableFilter>(initialFilter)
  const [addOpen, setAddOpen] = useState(false)

  const stalledSet = useMemo(() => new Set(stalledIds), [stalledIds])
  const followUpDueSet = useMemo(() => new Set(followUpDueIds), [followUpDueIds])

  if (isMobile) {
    return (
      <PipelineMobileWorkspace
        funnelStages={funnelStages}
        attentionCounts={attentionCounts}
        newInquiries={newInquiries}
        prospects={prospects}
        teamMembers={teamMembers}
        canCreate={canCreate}
      />
    )
  }

  // Selecting the already-active stage/bucket toggles the filter back to the default active view.
  const toggleFilter = (next: ProspectTableFilter) => {
    setActiveFilter((current) => (current === next ? "active" : next))
  }

  const isDefault = activeFilter === "active" || activeFilter === "all"
  const funnelActive = !isDefault && activeFilter !== "stalled" ? (activeFilter as ProspectStatus) : null

  return (
    <div className="space-y-5">
      <PipelineFunnelBar stages={funnelStages} activeStatus={funnelActive} onSelect={(status) => toggleFilter(status)} />

      <ProspectsClient
        prospects={prospects}
        teamMembers={teamMembers}
        canCreate={canCreate}
        canEdit={canEdit}
        attentionCounts={attentionCounts}
        activeFilter={activeFilter}
        onSelectFilter={setActiveFilter}
        onClearFilter={() => setActiveFilter("active")}
        stalledIds={stalledSet}
        followUpDueIds={followUpDueSet}
        onAddProspect={canCreate ? () => setAddOpen(true) : undefined}
      />

      <AddProspectDialog open={addOpen} onOpenChange={setAddOpen} teamMembers={teamMembers} />
    </div>
  )
}
