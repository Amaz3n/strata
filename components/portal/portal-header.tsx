"use client"

import { Badge } from "@/components/ui/badge"
import { ExternalWorkspaceSwitcher } from "@/components/portal/external-workspace-switcher"
import { cn } from "@/lib/utils"
import type { ExternalPortalWorkspaceContext, Project } from "@/lib/types"

const statusStyles: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

interface PortalHeaderProps {
  orgName: string
  project: Project
  workspace?: ExternalPortalWorkspaceContext | null
}

export function PortalHeader({ orgName, project, workspace = null }: PortalHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className="flex flex-col gap-2 px-5 py-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-medium">{orgName}</p>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-xl font-bold tracking-tight text-foreground">{project.name}</h1>
            {project.address ? <p className="truncate text-xs text-muted-foreground">{project.address}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {workspace ? <ExternalWorkspaceSwitcher workspace={workspace} /> : null}
            <Badge variant="outline" className={cn("capitalize shrink-0 text-[10px] px-2.5 py-0.5", statusStyles[project.status] ?? "")}>
              {project.status.replaceAll("_", " ")}
            </Badge>
          </div>
        </div>
      </div>
    </header>
  )
}
