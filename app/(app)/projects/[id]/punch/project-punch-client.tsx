"use client"

import { PunchTab } from "@/components/punch/punch-tab"
import type { ProjectPunchItem, ProjectTeamMember } from "../actions"

interface ProjectPunchClientProps {
  projectId: string
  initialItems: ProjectPunchItem[]
  team: ProjectTeamMember[]
}

export function ProjectPunchClient({ projectId, initialItems, team }: ProjectPunchClientProps) {
  return (
    <PunchTab
      projectId={projectId}
      initialItems={initialItems}
      team={team}
    />
  )
}
