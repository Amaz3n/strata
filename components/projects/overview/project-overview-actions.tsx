"use client"

import { useState, useEffect, useMemo, useCallback, useRef, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"

import type { Project, ProjectAccessPerson } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import {
  loadProjectAccessRosterAction,
  revokePortalTokenAction,
  pausePortalTokenAction,
  resumePortalTokenAction,
  setPortalTokenPinAction,
  setPortalTokenRequireAccountAction,
  removePortalTokenPinAction,
} from "@/app/(app)/sharing/actions"
import {
  getProjectOverviewCatalogsAction,
  getProjectSettingsAction,
  updateProjectSettingsAction,
  type ProjectOverviewCatalogs,
} from "@/app/(app)/projects/[id]/actions"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { ProjectAvatar } from "@/components/ui/project-avatar"

import { usePageTitle } from "@/components/layout/page-title-context"
import { getProjectPosture } from "@/lib/product-tier"
import { ProjectInviteForm } from "@/components/sharing/project-invite-form"
import { ProjectAccessRoster } from "@/components/sharing/project-access-roster"
import { ProjectSettingsSheet } from "@/components/projects/project-settings-sheet"
import { ManageTeamSheet } from "@/components/projects/manage-team-sheet"

import {
  Share2,
  MoreHorizontal,
  Settings,
  Users,
  MapPin,
} from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

interface ProjectOverviewActionsProps {
  project: Project
}

/**
 * The identity band: the one part of the overview that must be on screen the
 * instant the route resolves. It reads nothing but the project row.
 *
 * The three sheets behind it need org-wide catalogs (every contact, every
 * company, the project team, its vendors, its contract). Those load on pointer
 * intent and are awaited on open — never on the render path.
 */
export function ProjectOverviewActions({ project }: ProjectOverviewActionsProps) {
  const router = useRouter()
  const { productTier } = usePageTitle()
  const posture = getProjectPosture(project.property_type, productTier)

  const [catalogs, setCatalogs] = useState<ProjectOverviewCatalogs | null>(null)
  const [catalogsError, setCatalogsError] = useState<string | null>(null)
  const catalogRequest = useRef<Promise<ProjectOverviewCatalogs> | null>(null)

  // One in-flight request no matter how many triggers fire: hovering Share, then
  // opening the menu, then opening Manage team must not queue three loads.
  const warmCatalogs = useCallback(() => {
    if (catalogRequest.current) return catalogRequest.current
    const request = getProjectOverviewCatalogsAction(project.id)
    catalogRequest.current = request
    request.then(
      (loaded) => {
        setCatalogs(loaded)
        setCatalogsError(null)
      },
      (error) => {
        console.error("Failed to load project catalogs", error)
        catalogRequest.current = null
        setCatalogsError("Couldn't load contacts and companies.")
      },
    )
    return request
  }, [project.id])

  // The header renders from the light `project` prop; the settings sheet needs the full project
  // (financial_settings + billing_contract), which we lazy-load when the sheet opens.
  const [settingsProject, setSettingsProject] = useState<Project | null>(null)
  const [settingsLoading, startSettingsLoad] = useTransition()
  const [sharingSheetOpen, setSharingSheetOpen] = useState(false)
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false)
  const [manageTeamOpen, setManageTeamOpen] = useState(false)

  const [roster, setRoster] = useState<ProjectAccessPerson[]>([])
  const [sharingLoading, setSharingLoading] = useState(false)
  const [sharingInitialized, setSharingInitialized] = useState(false)
  const [sharingError, setSharingError] = useState<string | null>(null)

  const activeCount = useMemo(
    () => roster.filter((person) => person.status === "active").length,
    [roster],
  )

  const refreshRoster = useCallback(async () => {
    setSharingLoading(true)
    setSharingError(null)
    try {
      setRoster(await loadProjectAccessRosterAction(project.id))
      setSharingInitialized(true)
    } catch (error) {
      console.error(error)
      setSharingError("Unable to load who has access.")
    } finally {
      setSharingLoading(false)
    }
  }, [project.id])

  // Creating access joins contact and company rows for the roster, so the list is
  // re-read rather than patched optimistically from the returned token.
  function handleTokenCreated() {
    void refreshRoster()
  }

  async function runRosterAction(
    label: string,
    action: () => Promise<unknown>,
  ) {
    setSharingLoading(true)
    try {
      unwrapAction((await action()) as Parameters<typeof unwrapAction>[0])
      await refreshRoster()
      toast.success(label)
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setSharingLoading(false)
    }
  }

  const handleRevoke = (person: ProjectAccessPerson) =>
    runRosterAction("Access removed", () =>
      revokePortalTokenAction({ token_id: person.token_id, project_id: project.id }),
    )

  const handlePause = (person: ProjectAccessPerson) =>
    runRosterAction("Access paused", () =>
      pausePortalTokenAction({ token_id: person.token_id, project_id: project.id }),
    )

  const handleResume = (person: ProjectAccessPerson) =>
    runRosterAction("Access resumed", () =>
      resumePortalTokenAction({ token_id: person.token_id, project_id: project.id }),
    )

  const handleSetPin = (tokenId: string, pin: string) =>
    runRosterAction("PIN updated", () => setPortalTokenPinAction({ token_id: tokenId, pin }))

  const handleClearPin = (tokenId: string) =>
    runRosterAction("PIN removed", () => removePortalTokenPinAction({ token_id: tokenId }))

  const handleSetRequireAccount = (tokenId: string, requireAccount: boolean) =>
    runRosterAction(requireAccount ? "Account now required" : "Link-only access allowed", () =>
      setPortalTokenRequireAccountAction({ token_id: tokenId, require_account: requireAccount }),
    )

  useEffect(() => {
    if (sharingSheetOpen && !sharingInitialized) {
      void refreshRoster()
    }
  }, [sharingInitialized, sharingSheetOpen, refreshRoster])

  const openSettings = () => {
    startSettingsLoad(async () => {
      try {
        const [full] = await Promise.all([getProjectSettingsAction(project.id), warmCatalogs()])
        if (!full) {
          toast.error("Could not load project settings")
          return
        }
        setSettingsProject(full)
        setSettingsSheetOpen(true)
      } catch (error) {
        console.error(error)
        toast.error("Could not load project settings")
      }
    })
  }

  const handleSaveProject = async (input: Partial<ProjectInput>) => {
    const updated = unwrapAction(await updateProjectSettingsAction(project.id, input))
    setSettingsProject(updated)
    router.refresh()
  }

  return (
    <>
      <header className="border-b" data-instant-shell="project-overview">
        <div className="px-5 sm:px-8 lg:px-12 py-5 flex items-center gap-4">
          <ProjectAvatar projectId={project.id} size="xl" className="h-12 w-12" />

          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight truncate leading-tight">
              {project.name}
            </h1>
            {project.address && (
              <Link
                href={`https://maps.google.com/?q=${encodeURIComponent(project.address)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors max-w-full min-w-0 truncate"
              >
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{project.address}</span>
              </Link>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Sheet
              open={sharingSheetOpen}
              onOpenChange={(open) => {
                if (open) void warmCatalogs()
                setSharingSheetOpen(open)
              }}
            >
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 h-9 px-3 text-xs font-medium"
                  onPointerEnter={() => void warmCatalogs()}
                  onFocus={() => void warmCatalogs()}
                >
                  <Share2 className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Share</span>
                </Button>
              </SheetTrigger>
              <SheetContent
                side="right"
                mobileFullscreen
                className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 overflow-hidden fast-sheet-animation"
              >
                <div className="flex h-full min-h-0 flex-col">
                  <div className="border-b border-border px-4 py-3.5 sm:px-5 sm:py-4">
                    <SheetHeader className="text-left">
                      <SheetTitle className="text-sm font-semibold tracking-tight">
                        Project access
                      </SheetTitle>
                      <SheetDescription className="mt-0.5 text-xs leading-normal text-muted-foreground">
                        Everyone outside your team who can reach {project.name}.
                      </SheetDescription>
                    </SheetHeader>
                  </div>

                  <ScrollArea className="min-h-0 flex-1 overflow-x-hidden">
                    <div className="space-y-4 overflow-hidden p-4 sm:p-5">
                      <div className="border border-border bg-card p-5">
                        {catalogsError ? (
                          <CatalogError message={catalogsError} onRetry={warmCatalogs} />
                        ) : catalogs ? (
                          <ProjectInviteForm
                            projectId={project.id}
                            project={project}
                            posture={posture}
                            contacts={catalogs.contacts}
                            projectVendors={catalogs.projectVendors}
                            onCreated={handleTokenCreated}
                            enabled={sharingSheetOpen}
                          />
                        ) : (
                          <CatalogSkeleton rows={3} />
                        )}
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <h3 className="text-sm font-medium">Who has access</h3>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {activeCount} active
                          </span>
                        </div>

                        {sharingError ? (
                          <div className="border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
                            <p>{sharingError}</p>
                            <Button
                              variant="outline"
                              size="sm"
                              className="mt-2"
                              onClick={() => void refreshRoster()}
                            >
                              Try again
                            </Button>
                          </div>
                        ) : !sharingInitialized && sharingLoading ? (
                          <div className="space-y-2">
                            {[0, 1].map((row) => (
                              <div key={row} className="h-20 animate-pulse border border-border bg-muted/40" />
                            ))}
                          </div>
                        ) : (
                          <ProjectAccessRoster
                            people={roster}
                            posture={posture}
                            isLoading={sharingLoading}
                            onRevoke={handleRevoke}
                            onPause={handlePause}
                            onResume={handleResume}
                            onSetPin={handleSetPin}
                            onClearPin={handleClearPin}
                            onSetRequireAccount={handleSetRequireAccount}
                          />
                        )}
                      </div>
                    </div>
                  </ScrollArea>
                </div>
              </SheetContent>
            </Sheet>

            <DropdownMenu onOpenChange={(open) => { if (open) void warmCatalogs() }}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  onPointerEnter={() => void warmCatalogs()}
                  onFocus={() => void warmCatalogs()}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={settingsLoading}
                  onSelect={(e) => { e.preventDefault(); openSettings() }}
                >
                  <Settings className="mr-2 h-4 w-4" />
                  {settingsLoading ? "Loading…" : "Project settings"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(e) => {
                    e.preventDefault()
                    void warmCatalogs()
                    setManageTeamOpen(true)
                  }}
                >
                  <Users className="mr-2 h-4 w-4" />
                  Manage team
                </DropdownMenuItem>


                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">Archive project</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      {settingsProject ? (
        <ProjectSettingsSheet
          project={settingsProject}
          contract={catalogs?.contract ?? null}
          contacts={catalogs?.contacts ?? []}
          open={settingsSheetOpen}
          onOpenChange={setSettingsSheetOpen}
          onSave={handleSaveProject}
        />
      ) : null}
      <ManageTeamSheet
        projectId={project.id}
        open={manageTeamOpen}
        onOpenChange={setManageTeamOpen}
        team={catalogs?.team ?? []}
        contacts={catalogs?.contacts ?? []}
        companies={catalogs?.companies ?? []}
        projectVendors={catalogs?.projectVendors ?? []}
        isLoading={manageTeamOpen && !catalogs}
      />
    </>
  )
}

function CatalogSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, row) => (
        <div key={row} className="h-9 animate-pulse border border-border bg-muted/40" />
      ))}
    </div>
  )
}

function CatalogError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
      <p>{message}</p>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
