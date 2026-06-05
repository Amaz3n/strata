"use client"

import { useState, useEffect, useMemo, useCallback, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"

import type {
  Project,
  Contact,
  PortalAccessToken,
  ExternalPortalAccount,
  Proposal,
  Contract,
  DrawSchedule,
  Company,
  ProjectVendor,
} from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import {
  loadSharingDataAction,
  loadProjectExternalPortalAccountsAction,
  revokePortalTokenAction,
  pausePortalTokenAction,
  resumePortalTokenAction,
  setExternalPortalAccountStatusAction,
  setPortalTokenPinAction,
  removePortalTokenPinAction,
} from "@/app/(app)/sharing/actions"
import { getProjectSettingsAction, updateProjectSettingsAction } from "@/app/(app)/projects/[id]/actions"
import type { ProjectTeamMember } from "@/app/(app)/projects/[id]/actions"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { ProjectAvatar } from "@/components/ui/project-avatar"

import { PortalLinkCreator } from "@/components/sharing/portal-link-creator"
import { AccessTokenList } from "@/components/sharing/access-token-list"
import { PortalAccountList } from "@/components/sharing/portal-account-list"
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

interface ProjectOverviewActionsProps {
  project: Project
  contacts: Contact[]
  companies: Company[]
  team: ProjectTeamMember[]
  projectVendors: ProjectVendor[]
  portalTokens: PortalAccessToken[]
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
  portalTokens: initialPortalTokens,
  proposals,
  contract,
  draws,
  scheduleItemCount,
}: ProjectOverviewActionsProps) {
  const router = useRouter()

  // The header renders from the light `project` prop; the settings sheet needs the full project
  // (financial_settings + billing_contract), which we lazy-load when the sheet opens.
  const [settingsProject, setSettingsProject] = useState<Project | null>(null)
  const [settingsLoading, startSettingsLoad] = useTransition()
  const [sharingSheetOpen, setSharingSheetOpen] = useState(false)
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false)
  const [contractSheetOpen, setContractSheetOpen] = useState(false)
  const [manageTeamOpen, setManageTeamOpen] = useState(false)

  const [portalTokensState, setPortalTokensState] = useState<PortalAccessToken[]>(initialPortalTokens)
  const [externalAccounts, setExternalAccounts] = useState<ExternalPortalAccount[]>([])
  const [sharingLoading, setSharingLoading] = useState(false)
  const [sharingInitialized, setSharingInitialized] = useState(Boolean(initialPortalTokens.length))
  const [accountsInitialized, setAccountsInitialized] = useState(false)

  useEffect(() => {
    setPortalTokensState(initialPortalTokens)
    setSharingInitialized(Boolean(initialPortalTokens.length))
    setAccountsInitialized(false)
  }, [initialPortalTokens])

  const { clientActiveLinks, subActiveLinks, activeTokens } = useMemo(() => {
    const activeClient = portalTokensState.filter((token) => token.portal_type === "client" && !token.revoked_at && !token.paused_at).length
    const activeSubs = portalTokensState.filter((token) => token.portal_type === "sub" && !token.revoked_at && !token.paused_at).length
    const actives = portalTokensState.filter((token) => !token.revoked_at)
    return { clientActiveLinks: activeClient, subActiveLinks: activeSubs, activeTokens: actives }
  }, [portalTokensState])

  const refreshPortalTokens = useCallback(async () => {
    setSharingLoading(true)
    try {
      const [tokens, accounts] = await Promise.all([
        loadSharingDataAction(project.id),
        loadProjectExternalPortalAccountsAction(project.id),
      ])
      setPortalTokensState(tokens)
      setExternalAccounts(accounts)
      setSharingInitialized(true)
      setAccountsInitialized(true)
    } catch (error) {
      console.error(error)
      toast.error("Unable to load sharing links")
    } finally {
      setSharingLoading(false)
    }
  }, [project.id])

  function handleTokenCreated(token: PortalAccessToken) {
    setPortalTokensState((prev) => {
      const existingIndex = prev.findIndex((item) => item.id === token.id)
      if (existingIndex >= 0) {
        const next = [...prev]
        next[existingIndex] = token
        return next
      }
      return [token, ...prev]
    })
    setSharingInitialized(true)
  }

  async function handleTokenRevoke(tokenId: string) {
    setSharingLoading(true)
    try {
      await revokePortalTokenAction({ token_id: tokenId, project_id: project.id })
      setPortalTokensState((prev) =>
        prev.map((token) =>
          token.id === tokenId ? { ...token, revoked_at: new Date().toISOString() } : token
        )
      )
      toast.success("Access revoked")
    } catch (error) {
      console.error(error)
      toast.error("Failed to revoke link")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleSetPin(tokenId: string, pin: string) {
    setSharingLoading(true)
    try {
      await setPortalTokenPinAction({ token_id: tokenId, pin })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, pin_required: true } : token))
      )
      toast.success("PIN updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to set PIN")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleTokenPause(tokenId: string) {
    setSharingLoading(true)
    try {
      await pausePortalTokenAction({ token_id: tokenId, project_id: project.id })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, paused_at: new Date().toISOString() } : token))
      )
      toast.success("Access paused")
    } catch (error) {
      console.error(error)
      toast.error("Failed to pause access")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleTokenResume(tokenId: string) {
    setSharingLoading(true)
    try {
      await resumePortalTokenAction({ token_id: tokenId, project_id: project.id })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, paused_at: null } : token))
      )
      toast.success("Access resumed")
    } catch (error) {
      console.error(error)
      toast.error("Failed to resume access")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleClearPin(tokenId: string) {
    setSharingLoading(true)
    try {
      await removePortalTokenPinAction({ token_id: tokenId })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, pin_required: false } : token))
      )
      toast.success("PIN removed")
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove PIN")
    } finally {
      setSharingLoading(false)
    }
  }

  async function handleSetAccountStatus(accountId: string, status: "active" | "paused" | "revoked") {
    setSharingLoading(true)
    try {
      await setExternalPortalAccountStatusAction({ account_id: accountId, project_id: project.id, status })
      setExternalAccounts((prev) =>
        prev.map((account) =>
          account.id === accountId
            ? {
                ...account,
                status,
                paused_at: status === "paused" ? new Date().toISOString() : null,
                revoked_at: status === "revoked" ? new Date().toISOString() : null,
              }
            : account
        )
      )
      toast.success(`Account ${status}`)
    } catch (error) {
      console.error(error)
      toast.error("Failed to update account status")
    } finally {
      setSharingLoading(false)
    }
  }

  useEffect(() => {
    if (sharingSheetOpen && (!sharingInitialized || !accountsInitialized)) {
      void refreshPortalTokens()
    }
  }, [accountsInitialized, sharingInitialized, sharingSheetOpen, refreshPortalTokens])

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
    const updated = await updateProjectSettingsAction(project.id, input)
    setSettingsProject(updated)
    router.refresh()
  }

  return (
    <>
      <header className="border-b">
        <div className="px-5 sm:px-8 lg:px-12 py-5 flex items-center gap-4">
          <ProjectAvatar
            projectId={project.id}
            size="xl"
            animated
            className="h-12 w-12 rounded-none"
          />

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
                  <div className="border-b px-4 py-3.5 sm:px-5 sm:py-4 bg-muted/10">
                    <SheetHeader className="text-left">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center bg-primary/10 rounded-xl border border-primary/20">
                          <Share2 className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <SheetTitle className="text-sm font-bold tracking-tight text-foreground">Share Project Access</SheetTitle>
                          <SheetDescription className="text-[11px] text-muted-foreground leading-normal mt-0.5">
                            Securely invite homeowners and subcontractors via email or direct shareable links.
                          </SheetDescription>
                        </div>
                      </div>
                    </SheetHeader>
                  </div>

                  <ScrollArea className="flex-1 min-h-0 overflow-x-hidden">
                    <div className="space-y-4 p-4 sm:p-5 overflow-hidden">
                      <div className="border bg-card p-5 rounded-none shadow-sm">
                        <PortalLinkCreator
                          projectId={project.id}
                          project={project}
                          contacts={contacts}
                          projectVendors={projectVendors}
                          onCreated={handleTokenCreated}
                          enabled={sharingSheetOpen}
                        />
                      </div>

                      <Accordion type="single" collapsible className="border bg-card rounded-lg">
                        <AccordionItem value="active-access" className="border-none">
                          <AccordionTrigger className="px-4 py-3 hover:no-underline">
                            <div className="flex w-full items-center justify-between gap-2">
                              <div className="flex items-center gap-2">
                                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                                <span className="text-sm font-medium">Active links</span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {clientActiveLinks + subActiveLinks > 0 ? (
                                  <>
                                    <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-xs">
                                      <User className="h-3 w-3" />
                                      {clientActiveLinks}
                                    </Badge>
                                    <Badge variant="secondary" className="gap-1 px-2 py-0.5 text-xs">
                                      <Users className="h-3 w-3" />
                                      {subActiveLinks}
                                    </Badge>
                                  </>
                                ) : (
                                  <Badge variant="outline" className="text-xs text-muted-foreground">
                                    None
                                  </Badge>
                                )}
                              </div>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4 pb-4">
                            <AccessTokenList
                              projectId={project.id}
                              tokens={activeTokens}
                              onRevoke={handleTokenRevoke}
                              onPause={handleTokenPause}
                              onResume={handleTokenResume}
                              isLoading={sharingLoading}
                              onSetPin={handleSetPin}
                              onClearPin={handleClearPin}
                            />
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>

                      <Accordion type="single" collapsible className="border bg-card rounded-lg">
                        <AccordionItem value="claimed-accounts" className="border-none">
                          <AccordionTrigger className="px-4 py-3 hover:no-underline">
                            <div className="flex w-full items-center justify-between gap-2">
                              <span className="text-sm font-medium">Claimed accounts</span>
                              <Badge variant="outline" className="text-xs">{externalAccounts.length}</Badge>
                            </div>
                          </AccordionTrigger>
                          <AccordionContent className="px-4 pb-4">
                            <PortalAccountList
                              accounts={externalAccounts}
                              isLoading={sharingLoading}
                              onSetStatus={handleSetAccountStatus}
                            />
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
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
