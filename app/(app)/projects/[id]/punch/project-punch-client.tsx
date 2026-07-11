"use client"

import { PunchTab } from "@/components/punch/punch-tab"
import type { ProjectPunchItem, ProjectTeamMember } from "../actions"

interface ProjectPunchClientProps {
  projectId: string
  initialItems: ProjectPunchItem[]
  team: ProjectTeamMember[]
  companies: Array<{ id: string; name: string }>
}

export function ProjectPunchClient({ projectId, initialItems, team, companies }: ProjectPunchClientProps) {
  return (
    <PunchTab
      projectId={projectId}
      initialItems={initialItems}
      team={team}
      companies={companies}
    />
  )
}
