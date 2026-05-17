"use client"

import { useRouter } from "next/navigation"

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
  opportunityCounts: Record<OpportunityStatus, number>
  overdueFollowUps: Prospect[]
  upcomingFollowUps: Prospect[]
  newInquiries: Prospect[]
  stalledOpportunities: Opportunity[]
  stalledAfterDays: number
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
  overdueFollowUps,
  upcomingFollowUps,
  newInquiries,
  stalledOpportunities,
  stalledAfterDays,
  recentActivity,
  prospects,
  opportunities,
  teamMembers,
  clients,
  canCreate = false,
  canEdit = false,
  canManageProjects = false,
}: PipelineWorkspaceClientProps) {
  const router = useRouter()

  const handleViewChange = (next: string) => {
    const nextView = (next === "opportunities" || next === "prospects" ? next : "overview") as PipelineView
    const params = new URLSearchParams()
    if (nextView !== "overview") params.set("view", nextView)
    const qs = params.toString()
    router.replace(qs ? `/pipeline?${qs}` : "/pipeline", { scroll: false })
  }

  const renderTabSwitcher = () => (
    <TabsList>
      <TabsTrigger value="overview">Overview</TabsTrigger>
      <TabsTrigger value="opportunities">Opportunities</TabsTrigger>
      <TabsTrigger value="prospects">Prospects</TabsTrigger>
    </TabsList>
  )

  return (
    <Tabs value={initialView} onValueChange={handleViewChange} className="space-y-6">
      <TabsContent value="overview" className="space-y-6">
        <PipelineDashboard
          headerLeft={renderTabSwitcher()}
          opportunityCounts={opportunityCounts}
          overdueFollowUps={overdueFollowUps}
          upcomingFollowUps={upcomingFollowUps}
          newInquiries={newInquiries}
          stalledOpportunities={stalledOpportunities}
          stalledAfterDays={stalledAfterDays}
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
