import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { ExternalWorkspaceSwitcher } from "@/components/portal/external-workspace-switcher"
import { cn } from "@/lib/utils"
import type { ExternalPortalWorkspaceContext, Project } from "@/lib/types"

interface PortalHeaderProps {
  orgName: string
  project: Project
  workspace?: ExternalPortalWorkspaceContext | null
  logoUrl?: string | null
}

export function PortalHeader({ orgName, project, workspace = null, logoUrl = null }: PortalHeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/60">
      <div className="flex flex-col gap-2 px-5 py-4">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-medium">{orgName}</p>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="truncate text-xl font-bold tracking-tight text-foreground">{project.name}</h1>
            {project.address ? <p className="truncate text-xs text-muted-foreground">{project.address}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {workspace ? <ExternalWorkspaceSwitcher workspace={workspace} /> : null}
            <Avatar className="h-16 w-16 rounded-none border border-border bg-white shadow-sm flex items-center justify-center shrink-0">
              {logoUrl ? (
                <AvatarImage src={logoUrl} alt={`${orgName} logo`} className="object-contain p-1.5 w-full h-full bg-white rounded-none" />
              ) : null}
              <AvatarFallback className="rounded-none bg-primary/10 text-primary text-base font-semibold uppercase w-full h-full flex items-center justify-center">
                {orgName.slice(0, 2)}
              </AvatarFallback>
            </Avatar>
          </div>
        </div>
      </div>
    </header>
  )
}

