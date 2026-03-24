"use client"

import { useEffect, useState } from "react"

import type { Contact, TeamMember } from "@/lib/types"
import type { Prospect, CrmActivity } from "@/lib/services/crm"
import type { Opportunity } from "@/lib/services/opportunities"
import type { LeadStatus } from "@/lib/validation/crm"
import type { OpportunityStatus } from "@/lib/validation/opportunities"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PipelineDashboard } from "@/components/pipeline/pipeline-dashboard"
import { ProspectsClient } from "@/components/prospects/prospects-client"
import { OpportunitiesClient } from "@/components/opportunities/opportunities-client"

type PipelineView = "overview" | "opportunities" | "prospects"

interface PipelineWorkspaceClientProps {
  initialView: PipelineView
  initialProspectStatus?: LeadStatus
  initialOpportunityStatus?: OpportunityStatus
  opportunityCounts: {
    new: number
    contacted: number
    qualified: number
    estimating: number
    proposed: number
    won: number
    lost: number
  }
  closedThisMonth: {
    won: number
    lost: number
  }
  winRate: number | null
  followUpsDue: Prospect[]
  newInquiries: Prospect[]
  recentActivity: CrmActivity[]
  prospects: Prospect[]
  opportunities: Opportunity[]
  teamMembers: TeamMember[]
  clients: Contact[]
  canCreate?: boolean
  canEdit?: boolean
  canManageProjects?: boolean
}

export function PipelineWorkspaceClient({
  initialView,
  initialProspectStatus,
  initialOpportunityStatus,
  opportunityCounts,
  closedThisMonth,
  winRate,
  followUpsDue,
  newInquiries,
  recentActivity,
  prospects,
  opportunities,
  teamMembers,
  clients,
  canCreate = false,
  canEdit = false,
  canManageProjects = false,
}: PipelineWorkspaceClientProps) {
  const [view, setView] = useState<PipelineView>(initialView)

  useEffect(() => {
    setView(initialView)
  }, [initialView])

  const renderTabSwitcher = () => (
    <TabsList>
      <TabsTrigger value="overview">Overview</TabsTrigger>
      <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
      <TabsTrigger value="prospects">Prospects</TabsTrigger>
    </TabsList>
  )

  return (
    <Tabs value={view} onValueChange={(next) => setView(next as PipelineView)} className="space-y-6">
      <TabsContent value="overview" className="space-y-6">
        <PipelineDashboard
          headerLeft={renderTabSwitcher()}
          opportunityCounts={opportunityCounts}
          closedThisMonth={closedThisMonth}
          winRate={winRate}
          followUpsDue={followUpsDue}
          newInquiries={newInquiries}
          recentActivity={recentActivity}
          teamMembers={teamMembers}
          canCreate={canCreate}
          canEdit={canEdit}
        />
      </TabsContent>

      <TabsContent value="opportunities">
        <OpportunitiesClient
          headerLeft={renderTabSwitcher()}
          opportunities={opportunities}
          teamMembers={teamMembers}
          clients={clients}
          initialStatusFilter={initialOpportunityStatus}
          canCreate={canCreate}
          canEdit={canEdit}
          canManageProjects={canManageProjects}
        />
      </TabsContent>

      <TabsContent value="prospects">
        <ProspectsClient
          headerLeft={renderTabSwitcher()}
          prospects={prospects}
          teamMembers={teamMembers}
          canCreate={canCreate}
          canEdit={canEdit}
          initialStatusFilter={initialProspectStatus}
        />
      </TabsContent>
    </Tabs>
  )
}
