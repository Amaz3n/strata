"use client"

import { useState, useEffect, useMemo } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { toast } from "sonner"

import type { Project, Contact, PortalAccessToken, Proposal, Contract, DrawSchedule, ScheduleItem, Company, ProjectVendor } from "@/lib/types"
import type { ProjectInput } from "@/lib/validation/projects"
import type { ProjectTeamMember } from "@/app/(app)/projects/[id]/actions"
import { loadSharingDataAction, revokePortalTokenAction, setPortalTokenPinAction, removePortalTokenPinAction } from "@/app/(app)/sharing/actions"
import { updateProjectSettingsAction } from "@/app/(app)/projects/[id]/actions"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

import { PortalLinkCreator } from "@/components/sharing/portal-link-creator"
import { AccessTokenList } from "@/components/sharing/access-token-list"
import { ProjectSettingsSheet } from "@/components/projects/project-settings-sheet"
import { ProjectSetupWizardSheet } from "@/app/(app)/projects/[id]/project-setup-wizard-sheet"
import { ContractDetailSheet } from "@/components/contracts/contract-detail-sheet"
import { ProjectOverviewSetupChecklist } from "./project-overview-setup-checklist"

import {
  Share2,
  MoreHorizontal,
  Settings,
  Users,
  CalendarDays,
  Plus,
  Upload,
  ClipboardList,
  Building2,
  Clock,
  DollarSign,
  Link2,
  User,
  ShieldCheck,
} from "@/components/icons"

interface ProjectOverviewActionsProps {
  project: Project
  contacts: Contact[]
  portalTokens: PortalAccessToken[]
  proposals: Proposal[]
  contract: Contract | null
  draws: DrawSchedule[]
  scheduleItemCount: number
}

const statusColors: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  bidding: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<string, string> = {
  planning: "Planning",
  bidding: "Bidding",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
}

export function ProjectOverviewActions({
  project,
  contacts,
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

  // Sharing state
  const [portalTokensState, setPortalTokensState] = useState<PortalAccessToken[]>(initialPortalTokens)
  const [sharingLoading, setSharingLoading] = useState(false)
  const [sharingInitialized, setSharingInitialized] = useState(Boolean(initialPortalTokens.length))

  useEffect(() => {
    setPortalTokensState(initialPortalTokens)
    setSharingInitialized(Boolean(initialPortalTokens.length))
  }, [initialPortalTokens])

  const { clientActiveLinks, subActiveLinks, activeTokens } = useMemo(() => {
    const activeClient = portalTokensState.filter((token) => token.portal_type === "client" && !token.revoked_at).length
    const activeSubs = portalTokensState.filter((token) => token.portal_type === "sub" && !token.revoked_at).length
    const actives = portalTokensState.filter((token) => !token.revoked_at)
    return { clientActiveLinks: activeClient, subActiveLinks: activeSubs, activeTokens: actives }
  }, [portalTokensState])
  const activePortalLinks = clientActiveLinks + subActiveLinks

  async function refreshPortalTokens() {
    setSharingLoading(true)
    try {
      const tokens = await loadSharingDataAction(project.id)
      setPortalTokensState(tokens)
      setSharingInitialized(true)
    } catch (error) {
      console.error(error)
      toast.error("Unable to load sharing links")
    } finally {
      setSharingLoading(false)
    }
  }

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

  useEffect(() => {
    if (sharingSheetOpen && !sharingInitialized) {
      void refreshPortalTokens()
    }
  }, [sharingInitialized, sharingSheetOpen])

  const handleSaveProject = async (input: Partial<ProjectInput>) => {
    await updateProjectSettingsAction(project.id, input)
    router.refresh()
  }

  // Create schedule items array for the checklist (just need count for validation)
  const scheduleItems = scheduleItemCount > 0 ? [{ id: "placeholder" } as ScheduleItem] : []

  return (
    <>
      {/* Header with project info */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
            <Badge variant="outline" className={statusColors[project.status]}>
              {statusLabels[project.status]}
            </Badge>
          </div>
          {project.address && (
            <p className="text-muted-foreground flex items-center gap-2">
              <Building2 className="h-4 w-4" />
              {project.address}
            </p>
          )}
          <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
            {project.start_date && project.end_date && (
              <span className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4" />
                {new Date(project.start_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} – {new Date(project.end_date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </span>
            )}
            {project.total_value && (
              <span className="flex items-center gap-1.5">
                <DollarSign className="h-4 w-4" />
                ${project.total_value.toLocaleString()}
              </span>
            )}
            {project.property_type && (
              <span className="capitalize">
                {project.property_type}
              </span>
            )}
            {project.project_type && (
              <span className="capitalize">
                {project.project_type.replace("_", " ")}
              </span>
            )}
          </div>
          {project.description && (
            <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
              {project.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Share Button */}
          <Sheet open={sharingSheetOpen} onOpenChange={setSharingSheetOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Share2 className="h-4 w-4" />
                Share
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="w-full sm:max-w-md overflow-hidden border-l bg-background p-0 flex min-h-0 flex-col"
            >
              <div className="flex h-full min-h-0 flex-col">
                {/* Header */}
                <div className="border-b px-4 py-3 sm:px-5 sm:py-4">
                  <SheetHeader className="text-left">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center bg-primary/10">
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

                <ScrollArea className="flex-1 min-h-0">
                  <div className="space-y-4 p-4 sm:p-5">
                    {/* Link Creator */}
                    <div className="border bg-card p-4">
                      <PortalLinkCreator projectId={project.id} onCreated={handleTokenCreated} />
                    </div>

                    {/* Active Links */}
                    <Accordion type="single" collapsible className="border bg-card">
                      <AccordionItem value="active-access" className="border-none">
                        <AccordionTrigger className="px-4 py-3 hover:no-underline">
                          <div className="flex w-full items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                              <span className="text-sm font-medium">Active links</span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {activePortalLinks > 0 ? (
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
                            isLoading={sharingLoading}
                            onSetPin={handleSetPin}
                            onClearPin={handleClearPin}
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
              <Button variant="outline" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setSettingsSheetOpen(true) }}>
                <Settings className="mr-2 h-4 w-4" />
                Project Settings
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/projects/${project.id}/team`}>
                  <Users className="mr-2 h-4 w-4" />
                  Manage Team
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive">Archive Project</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

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
        project={project}
        contacts={contacts}
        team={[]}
        proposals={proposals}
        contract={contract}
        scheduleItems={scheduleItems}
        drawsCount={draws.length}
        portalTokens={portalTokensState}
      />
      <ContractDetailSheet contract={contract} open={contractSheetOpen} onOpenChange={setContractSheetOpen} />

      {/* Collapsible Setup Checklist - only shown when incomplete */}
      <ProjectOverviewSetupChecklist
        project={project}
        proposals={proposals}
        contract={contract}
        draws={draws}
        scheduleItemCount={scheduleItemCount}
        portalTokens={portalTokensState}
        onOpenSetupWizard={() => setSetupWizardOpen(true)}
        onOpenProjectSettings={() => setSettingsSheetOpen(true)}
        onOpenShare={() => setSharingSheetOpen(true)}
      />
    </>
  )
}
