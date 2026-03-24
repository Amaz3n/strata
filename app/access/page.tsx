import Link from "next/link"

import { ExternalAccessLogin } from "@/components/portal/account/external-access-login"
import { ExternalPortalSignOutButton } from "@/components/portal/external-portal-sign-out-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getExternalPortalWorkspaceContext } from "@/lib/services/external-portal-auth"
import { cn } from "@/lib/utils"
import type { ExternalPortalWorkspaceItem } from "@/lib/types"

const statusStyles: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  bidding: "bg-primary/10 text-primary border-primary/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

function formatDate(value?: string | null) {
  if (!value) return null
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))
}

function groupWorkspaceItems(items: ExternalPortalWorkspaceItem[]) {
  const groups = new Map<string, { projectName: string; projectStatus: string; projectAddress?: string | null; items: ExternalPortalWorkspaceItem[] }>()

  for (const item of items) {
    const existing = groups.get(item.project_id)
    if (existing) {
      existing.items.push(item)
      continue
    }
    groups.set(item.project_id, {
      projectName: item.project_name,
      projectStatus: item.project_status,
      projectAddress: item.project_address ?? null,
      items: [item],
    })
  }

  return Array.from(groups.entries()).map(([projectId, group]) => ({
    projectId,
    ...group,
    items: group.items,
  }))
}

export const revalidate = 0

export default async function ExternalAccessPage() {
  const workspace = await getExternalPortalWorkspaceContext()

  if (!workspace) {
    return <ExternalAccessLogin />
  }

  const projectCount = new Set(workspace.items.map((item) => item.project_id)).size
  const groupedProjects = groupWorkspaceItems(workspace.items)

  return (
    <div className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="relative overflow-hidden border border-border bg-card p-6 sm:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.12),transparent_40%),linear-gradient(135deg,hsl(var(--muted)/0.4),transparent_60%)]" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-4">
              <Badge variant="outline" className="w-fit border-primary/30 bg-primary/10 text-primary">
                Arc workspace
              </Badge>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Everything you can access, in one place.</h1>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                  Signed in as {workspace.account.full_name || workspace.account.email}. Open any portal below or jump
                  back into a project from the selector in the header.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{workspace.org.name}</Badge>
                <Badge variant="outline">{projectCount} projects</Badge>
                <Badge variant="outline">{workspace.items.length} workspaces</Badge>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <ExternalPortalSignOutButton />
            </div>
          </div>
        </section>

        {groupedProjects.length === 0 ? (
          <Card>
            <CardContent className="p-8">
              <p className="text-lg font-medium">No active workspaces yet.</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Ask the builder to send you a new project or bid link, then claim access with your Arc account.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {groupedProjects.map((project) => (
              <Card key={project.projectId} className="border-border/80">
                <CardHeader className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <CardTitle className="truncate text-xl">{project.projectName}</CardTitle>
                      {project.projectAddress ? (
                        <p className="truncate text-sm text-muted-foreground">{project.projectAddress}</p>
                      ) : null}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn("capitalize shrink-0 text-[10px] px-2.5 py-0.5", statusStyles[project.projectStatus] ?? "")}
                    >
                      {project.projectStatus.replaceAll("_", " ")}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {project.items.map((item) => (
                    <div key={item.id} className="flex items-start justify-between gap-3 border border-border/70 bg-background/60 p-4">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline" className="text-[10px] uppercase tracking-[0.18em]">
                            {item.label}
                          </Badge>
                          {item.due_at ? (
                            <span className="text-xs text-muted-foreground">Due {formatDate(item.due_at)}</span>
                          ) : null}
                        </div>
                        <p className="text-sm font-medium">{item.subtitle}</p>
                        {item.last_accessed_at ? (
                          <p className="text-xs text-muted-foreground">Last opened {formatDate(item.last_accessed_at)}</p>
                        ) : (
                          <p className="text-xs text-muted-foreground">Ready to open</p>
                        )}
                      </div>
                      <Button asChild size="sm">
                        <Link href={item.href}>Open</Link>
                      </Button>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
