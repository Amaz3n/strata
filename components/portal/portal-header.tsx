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
    <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className="flex flex-col gap-0.5 px-5 py-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-medium">{orgName}</p>
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-bold tracking-tight truncate text-foreground">{project.name}</h1>
          <Badge variant="outline" className={cn("capitalize shrink-0 text-[10px] px-2.5 py-0.5", statusStyles[project.status] ?? "")}>
            {project.status.replaceAll("_", " ")}
          </Badge>
        </div>
        {project.address && (
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{project.address}</p>
        )}
      </div>
    </header>
  )
}
