import Link from "next/link"

import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Plus, Search, MoreHorizontal, FolderOpen } from "@/components/icons"
import type { ProjectStatus, Project } from "@/lib/types"
import { listProjectsAction } from "./actions"
import { getCurrentUserAction } from "../actions/user"
import { ProjectsClient } from "./projects-client"

const statusColors: Record<ProjectStatus, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<ProjectStatus, string> = {
  planning: "Planning",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
}

export default async function ProjectsPage() {
  const [projects, currentUser] = await Promise.all([listProjectsAction(), getCurrentUserAction()])
  const projectBadge = projects.filter((p) => p.status !== "completed" && p.status !== "cancelled").length

  return (
    <AppShell title="Projects" user={currentUser} badges={{ projects: projectBadge }}>
      <div className="p-4 lg:p-6 space-y-6">
        <ProjectsClient projects={projects} />
      </div>
    </AppShell>
  )
}
