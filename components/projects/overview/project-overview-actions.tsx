"use client"

import { useState, useEffect, useMemo, useCallback, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"

import type {
  Project,
  Contact,
  ProjectAccessPerson,
  Proposal,
  Contract,
  DrawSchedule,
  Company,
  ProjectVendor,
} from "@/lib/types"
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
import { getProjectSettingsAction, updateProjectSettingsAction } from "@/app/(app)/projects/[id]/actions"
import type { ProjectTeamMember } from "@/app/(app)/projects/[id]/actions"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { ProjectAvatar } from "@/components/ui/project-avatar"

import { usePageTitle } from "@/components/layout/page-title-context"
import { getProjectPosture } from "@/lib/product-tier"
import { ProjectInviteForm } from "@/components/sharing/project-invite-form"
import { ProjectAccessRoster } from "@/components/sharing/project-access-roster"
import { ProjectSettingsSheet } from "@/components/projects/project-settings-sheet"
import { ContractDetailSheet } from "@/components/contracts/contract-detail-sheet"
import { ManageTeamSheet } from "@/components/projects/manage-team-sheet"

import {
  Share2,
  MoreHorizontal,
  Settings,
  Users,
  Link2,
  User,
  ShieldCheck,
  MapPin,
} from "@/components/icons"
import { cn } from "@/lib/utils"

import { unwrapAction } from "@/lib/action-result"

interface ProjectOverviewActionsProps {
  project: Project
  contacts: Contact[]
  companies: Company[]
  team: ProjectTeamMember[]
  projectVendors: ProjectVendor[]
  proposals: Proposal[]
  contract: Contract | null
  draws: DrawSchedule[]
  scheduleItemCount: number
}

export function ProjectOverviewActions({
  project,
  contacts,
  companies,
  team,
  projectVendors,
  proposals,
  contract,
  draws,
  scheduleItemCount,
}: ProjectOverviewActionsProps) {
  const router = useRouter()
  const { productTier } = usePageTitle()
  const posture = getProjectPosture(project.property_type, productTier)

  // The header renders from the light `project` prop; the settings sheet needs the full project
  // (financial_settings + billing_contract), which we lazy-load when the sheet opens.
  const [settingsProject, setSettingsProject] = useState<Project | null>(null)
  const [settingsLoading, startSettingsLoad] = useTransition()
  const [sharingSheetOpen, setSharingSheetOpen] = useState(false)
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false)
  const [contractSheetOpen, setContractSheetOpen] = useState(false)
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
        const full = await getProjectSettingsAction(project.id)
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
      <header className="border-b">
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
            <Sheet open={sharingSheetOpen} onOpenChange={setSharingSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5 h-9 px-3 text-xs font-medium">
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
                        <ProjectInviteForm
                          projectId={project.id}
                          project={project}
                          posture={posture}
                          contacts={contacts}
                          projectVendors={projectVendors}
                          onCreated={handleTokenCreated}
                          enabled={sharingSheetOpen}
                        />
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="h-9 w-9">
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
          contract={contract}
          contacts={contacts}
          open={settingsSheetOpen}
          onOpenChange={setSettingsSheetOpen}
          onSave={handleSaveProject}
        />
      ) : null}
      <ContractDetailSheet contract={contract} open={contractSheetOpen} onOpenChange={setContractSheetOpen} />
      <ManageTeamSheet
        projectId={project.id}
        open={manageTeamOpen}
        onOpenChange={setManageTeamOpen}
        team={team}
        contacts={contacts}
        companies={companies}
        projectVendors={projectVendors}
      />
    </>
  )
}
