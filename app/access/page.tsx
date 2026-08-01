import Link from "next/link"

import { ExternalAccessLogin } from "@/components/portal/account/external-access-login"
import { ExternalPortalSignOutButton } from "@/components/portal/external-portal-sign-out-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getExternalPortalWorkspaceContext } from "@/lib/services/external-portal-auth"
import { getVendorPaymentPortalContext } from "@/lib/services/vendor-payment-identities"
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
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value))
}

function groupByProject(items: ExternalPortalWorkspaceItem[]) {
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

  return Array.from(groups.entries()).map(([projectId, group]) => ({ projectId, ...group }))
}

export const revalidate = 0
export const metadata = {
  robots: { index: false, follow: false },
}

export default async function ExternalAccessPage() {
  const [workspace, paymentContext] = await Promise.all([
    getExternalPortalWorkspaceContext(),
    getVendorPaymentPortalContext().catch(() => null),
  ])

  if (!workspace) {
    return <ExternalAccessLogin />
  }

  const projectCount = new Set(workspace.items.map((item) => item.project_id)).size
  const paymentsHref = workspace.items.find((item) => item.href.startsWith("/s/"))?.href.concat("/payments") ?? null

  return (
    <div className="min-h-screen bg-background px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="relative overflow-hidden border border-border bg-card p-6 sm:p-8">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,var(--color-primary)/0.12,transparent_40%)]" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-4">
              <Badge variant="outline" className="w-fit border-primary/30 bg-primary/10 text-primary">
                Arc workspace
              </Badge>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Everything you can access, in one place.</h1>
                <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
                  Signed in as {workspace.identity.full_name || workspace.identity.email}. Your Arc account works with every
                  builder who invites you — new invitations appear here automatically.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">
                  {workspace.orgs.length} {workspace.orgs.length === 1 ? "builder" : "builders"}
                </Badge>
                <Badge variant="outline">{projectCount} projects</Badge>
                <Badge variant="outline">{workspace.items.length} workspaces</Badge>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <ExternalPortalSignOutButton />
            </div>
          </div>
        </section>

        {paymentContext?.identity && paymentsHref ? (
          <Card className="border-primary/25">
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-semibold">Vendor payment profile</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {paymentContext.entities.length} {paymentContext.entities.length === 1 ? "company" : "companies"} ·{" "}
                  {paymentContext.relationships.length} connected{" "}
                  {paymentContext.relationships.length === 1 ? "builder" : "builders"}
                </p>
              </div>
              <Button asChild variant="outline">
                <Link href={paymentsHref}>Manage payment profile</Link>
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {workspace.orgs.length === 0 ? (
          <Card>
            <CardContent className="p-8">
              <p className="text-lg font-medium">No active workspaces yet.</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Ask the builder to send you a new project or bid link. Once you open it, it will show up here.
              </p>
            </CardContent>
          </Card>
        ) : (
          workspace.orgs.map((org) => (
            <section key={org.id} className="space-y-4">
              <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
                <h2 className="text-lg font-semibold tracking-tight">{org.name}</h2>
                <span className="text-xs text-muted-foreground">
                  {org.items.length} {org.items.length === 1 ? "workspace" : "workspaces"}
                </span>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                {groupByProject(org.items).map((project) => (
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
                            {item.subtitle ? <p className="text-sm font-medium">{item.subtitle}</p> : null}
                            {item.due_at ? (
                              <p className="text-xs text-muted-foreground">Due {formatDate(item.due_at)}</p>
                            ) : null}
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
            </section>
          ))
        )}
      </div>
    </div>
  )
}
