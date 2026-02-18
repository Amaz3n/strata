"use client"

import { useState, useEffect, useMemo, useCallback } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"
import { format, parseISO } from "date-fns"

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
  setPortalTokenRequireAccountAction,
  setExternalPortalAccountStatusAction,
  setPortalTokenPinAction,
  removePortalTokenPinAction,
} from "@/app/(app)/sharing/actions"
import { updateProjectSettingsAction } from "@/app/(app)/projects/[id]/actions"
import type { ProjectTeamMember } from "@/app/(app)/projects/[id]/actions"

import { Card } from "@/components/ui/card"
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
import { ProjectSetupWizardSheet } from "@/app/(app)/projects/[id]/project-setup-wizard-sheet"
import { ContractDetailSheet } from "@/components/contracts/contract-detail-sheet"
import { ProjectOverviewSetupChecklist } from "./project-overview-setup-checklist"
import { ManageTeamSheet } from "@/components/projects/manage-team-sheet"

import {
  Share2,
  MoreHorizontal,
  Settings,
  Users,
  CalendarDays,
  DollarSign,
  Link2,
  User,
  ShieldCheck,
  MapPin,
  Building2,
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

const statusConfig: Record<string, { label: string; color: string; dot: string }> = {
  planning: { label: "Planning", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" },
  bidding: { label: "Bidding", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400", dot: "bg-blue-500" },
  active: { label: "Active", color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-500" },
  on_hold: { label: "On Hold", color: "bg-orange-500/10 text-orange-600 dark:text-orange-400", dot: "bg-orange-500" },
  completed: { label: "Completed", color: "bg-slate-500/10 text-slate-600 dark:text-slate-400", dot: "bg-slate-500" },
  cancelled: { label: "Cancelled", color: "bg-red-500/10 text-red-600 dark:text-red-400", dot: "bg-red-500" },
}

function formatCurrency(value: number): string {
  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(0)}K`
  }
  return `$${value.toLocaleString()}`
}

function formatProjectType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
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

  // Sheet states
  const [sharingSheetOpen, setSharingSheetOpen] = useState(false)
  const [settingsSheetOpen, setSettingsSheetOpen] = useState(false)
  const [setupWizardOpen, setSetupWizardOpen] = useState(false)
  const [contractSheetOpen, setContractSheetOpen] = useState(false)
  const [manageTeamOpen, setManageTeamOpen] = useState(false)

  // Sharing state
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
    setPortalTokensState((prev) => [token, ...prev])
    setSharingInitialized(true)
    toast.success("Link created", { description: "Share it with your client or sub." })
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

  async function handleSetRequireAccount(tokenId: string, requireAccount: boolean) {
    setSharingLoading(true)
    try {
      await setPortalTokenRequireAccountAction({
        token_id: tokenId,
        project_id: project.id,
        require_account: requireAccount,
      })
      setPortalTokensState((prev) =>
        prev.map((token) => (token.id === tokenId ? { ...token, require_account: requireAccount } : token))
      )
      toast.success(requireAccount ? "Account required enabled" : "Link-only access enabled")
    } catch (error) {
      console.error(error)
      toast.error("Failed to update access mode")
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

  const handleSaveProject = async (input: Partial<ProjectInput>) => {
    await updateProjectSettingsAction(project.id, input)
    router.refresh()
  }

  const status = statusConfig[project.status] || statusConfig.planning

  // Check if we have any metadata to show
  const hasTimeline = project.start_date && project.end_date
  const hasValue = project.total_value
  const hasType = project.property_type || project.project_type
  const hasMetadata = hasTimeline || hasValue || hasType

  return (
    <>
      <Card className="overflow-hidden py-0 gap-0">
        {/* Header Section */}
        <div className="px-4 pt-3.5 pb-2.5 sm:px-5 sm:pt-4 sm:pb-3">
          <div className="flex items-center gap-3">
            {/* Project Avatar */}
            <ProjectAvatar projectId={project.id} size="xl" />

            {/* Project Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {/* Project Name + Status */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="text-lg sm:text-xl font-semibold tracking-tight text-foreground truncate">
                      {project.name}
                    </h1>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "font-medium text-xs px-2 py-0.5 gap-1.5 shrink-0",
                        status.color
                      )}
                    >
                      <span className={cn("size-1.5 rounded-full", status.dot)} />
                      {status.label}
                    </Badge>
                  </div>

                </div>

                {/* Actions */}
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Share Button */}
                  <Sheet open={sharingSheetOpen} onOpenChange={setSharingSheetOpen}>
                    <SheetTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5 h-8 px-2.5">
                        <Share2 className="h-3.5 w-3.5" />
                        <span className="hidden sm:inline text-xs">Share</span>
                      </Button>
                    </SheetTrigger>
                    <SheetContent
                      side="right"
                      mobileFullscreen
                      className="sm:max-w-md sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 overflow-hidden fast-sheet-animation"
                    >
                      <div className="flex h-full min-h-0 flex-col">
                        <div className="border-b px-4 py-3 sm:px-5 sm:py-4">
                          <SheetHeader className="text-left">
                            <div className="flex items-center gap-3">
                              <div className="flex h-9 w-9 items-center justify-center bg-primary/10 rounded-lg">
                                <Link2 className="h-4 w-4 text-primary" />
                              </div>
                              <div>
                                <SheetTitle className="text-base font-semibold">Share access</SheetTitle>
                                <SheetDescription className="text-xs text-muted-foreground">
                                  Create a portal link for clients or subs
                                </SheetDescription>
                              </div>
                            </div>
                          </SheetHeader>
                        </div>

                        <ScrollArea className="flex-1 min-h-0 overflow-x-hidden">
                          <div className="space-y-4 p-4 sm:p-5 overflow-hidden">
                            <div className="border bg-card p-4 rounded-lg">
                              <PortalLinkCreator
                                projectId={project.id}
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
                                    onSetRequireAccount={handleSetRequireAccount}
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

                  {/* More Actions Menu */}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setSettingsSheetOpen(true) }}>
                        <Settings className="mr-2 h-4 w-4" />
                        Project Settings
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={(e) => {
                          e.preventDefault()
                          setManageTeamOpen(true)
                        }}
                      >
                        <Users className="mr-2 h-4 w-4" />
                        Manage Team
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive">Archive Project</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Metadata Grid */}
        {hasMetadata && (
          <div className="border-t border-border/50 bg-muted/30">
            <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-border/50">
              {/* Address */}
              <div className="px-4 py-3 sm:px-5">
                <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                  <MapPin className="h-3 w-3" />
                  <span className="text-[11px] font-medium uppercase tracking-wider">Address</span>
                </div>
                {project.address ? (
                  <Link
                    href={`https://maps.google.com/?q=${encodeURIComponent(project.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {project.address}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">No address set</span>
                )}
              </div>

              {/* Timeline */}
              {hasTimeline && (
                <div className="px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                    <CalendarDays className="h-3 w-3" />
                    <span className="text-[11px] font-medium uppercase tracking-wider">Timeline</span>
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {format(parseISO(project.start_date!), "MMM d")} — {format(parseISO(project.end_date!), "MMM d, yyyy")}
                  </p>
                </div>
              )}

              {/* Value */}
              {hasValue && (
                <div className="px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                    <DollarSign className="h-3 w-3" />
                    <span className="text-[11px] font-medium uppercase tracking-wider">Value</span>
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {formatCurrency(project.total_value!)}
                  </p>
                </div>
              )}

              {/* Type */}
              {hasType && (
                <div className="px-4 py-3 sm:px-5">
                  <div className="flex items-center gap-1.5 text-muted-foreground mb-0.5">
                    <Building2 className="h-3 w-3" />
                    <span className="text-[11px] font-medium uppercase tracking-wider">Type</span>
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    {[
                      project.property_type && formatProjectType(project.property_type),
                      project.project_type && formatProjectType(project.project_type),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Description */}
        {project.description && (
          <div className="border-t border-border/50 px-4 py-3 sm:px-5">
            <p className="text-sm text-muted-foreground leading-relaxed pl-3 border-l-2 border-border/60 italic">
              {project.description}
            </p>
          </div>
        )}

        {/* Setup Checklist */}
        <ProjectOverviewSetupChecklist
          project={project}
          proposals={proposals}
          contract={contract}
          draws={draws}
          scheduleItemCount={scheduleItemCount}
          portalTokens={portalTokensState}
          onOpenSetupWizard={() => setSetupWizardOpen(true)}
        />
      </Card>

      {/* Sheets */}
      <ProjectSettingsSheet
        project={project}
        contacts={contacts}
        open={settingsSheetOpen}
        onOpenChange={setSettingsSheetOpen}
        onSave={handleSaveProject}
      />
      <ProjectSetupWizardSheet
        open={setupWizardOpen}
        onOpenChange={setSetupWizardOpen}
        onOpenProjectSettings={() => {
          setSetupWizardOpen(false)
          setSettingsSheetOpen(true)
        }}
        onOpenTeamSheet={() => {
          setSetupWizardOpen(false)
          setManageTeamOpen(true)
        }}
        project={project}
        contacts={contacts}
        team={team}
        proposals={proposals}
        contract={contract}
        scheduleItemCount={scheduleItemCount}
        drawsCount={draws.length}
        portalTokens={portalTokensState}
      />
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
