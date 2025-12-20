"use client"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/types"

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
}

export function PortalHeader({ orgName, project }: PortalHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex flex-col gap-1 px-4 py-3">
        <p className="text-xs text-muted-foreground">{orgName}</p>
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold truncate">{project.name}</h1>
          <Badge variant="outline" className={cn("capitalize shrink-0", statusStyles[project.status] ?? "")}>
            {project.status.replaceAll("_", " ")}
          </Badge>
        </div>
      </div>
    </header>
  )
}
