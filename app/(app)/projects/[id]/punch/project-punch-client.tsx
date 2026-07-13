"use client"

import { PunchTab } from "@/components/punch/punch-tab"
import type { ProjectPunchItem, ProjectTeamMember } from "../actions"
import type { ProjectLocation } from "@/lib/services/locations"

interface ProjectPunchClientProps {
  projectId: string
  initialItems: ProjectPunchItem[]
  initialItemId?: string
  team: ProjectTeamMember[]
  companies: Array<{ id: string; name: string }>
  locations: ProjectLocation[]
  canManageLocations: boolean
}

export function ProjectPunchClient({ projectId, initialItems, initialItemId, team, companies, locations, canManageLocations }: ProjectPunchClientProps) {
  return (
    <PunchTab
      projectId={projectId}
      initialItems={initialItems}
      initialItemId={initialItemId}
      team={team}
      companies={companies}
      locations={locations}
      canManageLocations={canManageLocations}
    />
  )
}
