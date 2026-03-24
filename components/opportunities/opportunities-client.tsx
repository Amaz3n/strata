"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import type { ReactNode } from "react"

import type { Contact, TeamMember } from "@/lib/types"
import type { Opportunity } from "@/lib/services/opportunities"
import type { OpportunityStatus } from "@/lib/validation/opportunities"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AddOpportunityDialog } from "@/components/opportunities/add-opportunity-dialog"
import { OpportunityDetailSheet } from "@/components/opportunities/opportunity-detail-sheet"
import { OpportunityStatusBadge } from "@/components/opportunities/opportunity-status-badge"
import { MoreHorizontal, Plus } from "@/components/icons"
import { cn } from "@/lib/utils"
import { activateOpportunityProjectAction, startEstimatingAction } from "@/app/(app)/pipeline/opportunity-actions"

const statusOptions: OpportunityStatus[] = [
  "new",
  "contacted",
  "qualified",
  "estimating",
  "proposed",
  "won",
  "lost",
]

function formatBudgetRange(budget?: string | null): string {
  const map: Record<string, string> = {
    under_100k: "Under $100k",
    "100k_250k": "$100k - $250k",
    "250k_500k": "$250k - $500k",
    "500k_1m": "$500k - $1M",
    over_1m: "Over $1M",
    undecided: "Undecided",
  }
  return map[budget ?? ""] ?? "Not specified"
}

function formatTimeline(timeline?: string | null): string {
  const map: Record<string, string> = {
    asap: "ASAP",
    "3_months": "Within 3 months",
    "6_months": "Within 6 months",
    "1_year": "Within 1 year",
    flexible: "Flexible",
  }
  return map[timeline ?? ""] ?? "Not specified"
}

interface OpportunitiesClientProps {
  opportunities: Opportunity[]
  teamMembers: TeamMember[]
  clients: Contact[]
  initialStatusFilter?: OpportunityStatus
  canCreate?: boolean
  canEdit?: boolean
  canManageProjects?: boolean
  headerLeft?: ReactNode
}

export function OpportunitiesClient({
  opportunities,
  teamMembers,
  clients,
  initialStatusFilter,
  canCreate = false,
  canEdit = false,
  canManageProjects = false,
  headerLeft,
}: OpportunitiesClientProps) {
  const router = useRouter()
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | OpportunityStatus>(initialStatusFilter ?? "all")
  const [ownerFilter, setOwnerFilter] = useState("all")
  const [createOpen, setCreateOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)
  const [pendingOpportunityId, setPendingOpportunityId] = useState<string | null>(null)

  useEffect(() => {
    setStatusFilter(initialStatusFilter ?? "all")
  }, [initialStatusFilter])

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return opportunities.filter((opportunity) => {
      const matchesStatus = statusFilter === "all" || opportunity.status === statusFilter
      const matchesOwner =
        ownerFilter === "all" ||
        (ownerFilter === "unassigned"
          ? !opportunity.owner_user_id
          : opportunity.owner_user_id === ownerFilter)
      const client = opportunity.client_contact
      const haystack = [
        opportunity.name,
        client?.full_name ?? "",
        client?.email ?? "",
        client?.phone ?? "",
      ]
        .join(" ")
        .toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesStatus && matchesOwner && matchesSearch
    })
  }, [opportunities, statusFilter, ownerFilter, search])

  const openDetail = (opportunityId: string) => {
    setDetailId(opportunityId)
    setDetailOpen(true)
  }

  const getOwnerName = (userId?: string | null) => {
    if (!userId) return "Unassigned"
    return teamMembers.find((m) => m.user.id === userId)?.user.full_name ?? "Unknown"
  }

  const navigateToEstimateWorkspace = async (opportunity: Opportunity) => {
    try {
      setPendingOpportunityId(opportunity.id)
      const result = opportunity.project
        ? {
            project_id: opportunity.project.id,
            client_contact_id: opportunity.client_contact_id,
          }
        : await startEstimatingAction(opportunity.id)
      const params = new URLSearchParams()
      params.set("project", result.project_id)
      if (result.client_contact_id) {
        params.set("recipient", result.client_contact_id)
      }
      router.push(`/estimates?${params.toString()}`)
    } catch (error) {
      toast.error("Unable to start estimating", { description: (error as Error).message })
    } finally {
      setPendingOpportunityId(null)
    }
  }

  const activateAndOpenProject = async (opportunity: Opportunity) => {
    try {
      setPendingOpportunityId(opportunity.id)
      const result = await activateOpportunityProjectAction(opportunity.id)
      router.push(`/projects/${result.project_id}`)
    } catch (error) {
      toast.error("Unable to open project", { description: (error as Error).message })
    } finally {
      setPendingOpportunityId(null)
    }
  }

  const getPrimaryAction = (opportunity: Opportunity) => {
    switch (opportunity.status) {
      case "new":
      case "contacted":
        return null
      case "qualified":
        return {
          label: opportunity.project ? "Open estimate workspace" : "Create estimate workspace",
          onSelect: () => navigateToEstimateWorkspace(opportunity),
          requiresProjectManage: true,
        }
      case "estimating":
        return {
          label: opportunity.project ? "Continue estimating" : "Create estimate workspace",
          onSelect: () => navigateToEstimateWorkspace(opportunity),
          requiresProjectManage: true,
        }
      case "proposed":
        return {
          label: opportunity.project ? "Open precon workspace" : "Create precon workspace",
          onSelect: () => navigateToEstimateWorkspace(opportunity),
          requiresProjectManage: true,
        }
      case "won":
        return {
          label: "Open active project",
          onSelect: () => activateAndOpenProject(opportunity),
          requiresProjectManage: true,
        }
      case "lost":
        return null
      default:
        return null
    }
  }

  return (
    <div className="space-y-4">
      <AddOpportunityDialog open={createOpen} onOpenChange={setCreateOpen} teamMembers={teamMembers} clients={clients} />
      <OpportunityDetailSheet
        opportunityId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        teamMembers={teamMembers}
        canManageProjects={canManageProjects}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>{headerLeft}</div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add opportunity
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input
          placeholder="Search opportunities..."
          className="w-full sm:w-72"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select value={ownerFilter} onValueChange={setOwnerFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Owner" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All owners</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {teamMembers.map((member) => (
              <SelectItem key={member.user.id} value={member.user.id}>
                {member.user.full_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as OpportunityStatus | "all")}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {statusOptions.map((status) => (
              <SelectItem key={status} value={status}>
                {status[0].toUpperCase() + status.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Opportunity</TableHead>
              <TableHead className="px-4 py-4">Client</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4">Owner</TableHead>
              <TableHead className="px-4 py-4">Budget</TableHead>
              <TableHead className="px-4 py-4">Timeline</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  No opportunities match your filters.
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((opportunity) => {
                const primaryAction = getPrimaryAction(opportunity)

                return (
                  <TableRow key={opportunity.id} className={cn("divide-x", "hover:bg-muted/40 cursor-pointer")}>
                  <TableCell className="px-4 py-4" onClick={() => openDetail(opportunity.id)}>
                    <div className="font-medium">{opportunity.name}</div>
                    {opportunity.project?.status && (
                      <div className="text-xs text-muted-foreground">Project: {opportunity.project.status}</div>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4" onClick={() => openDetail(opportunity.id)}>
                    <div className="text-sm">{opportunity.client_contact?.full_name ?? "Unknown client"}</div>
                    {opportunity.client_contact?.email && (
                      <div className="text-xs text-muted-foreground">{opportunity.client_contact.email}</div>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center" onClick={() => openDetail(opportunity.id)}>
                    <OpportunityStatusBadge status={opportunity.status} />
                  </TableCell>
                  <TableCell className="px-4 py-4" onClick={() => openDetail(opportunity.id)}>
                    {getOwnerName(opportunity.owner_user_id)}
                  </TableCell>
                  <TableCell className="px-4 py-4" onClick={() => openDetail(opportunity.id)}>
                    {formatBudgetRange(opportunity.budget_range)}
                  </TableCell>
                  <TableCell className="px-4 py-4" onClick={() => openDetail(opportunity.id)}>
                    {formatTimeline(opportunity.timeline_preference)}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openDetail(opportunity.id)}>
                          View details
                        </DropdownMenuItem>
                        {opportunity.project && opportunity.status !== "won" && (
                          <DropdownMenuItem onClick={() => router.push(`/projects/${opportunity.project?.id}`)}>
                            Open project
                          </DropdownMenuItem>
                        )}
                        {primaryAction && (
                          <DropdownMenuItem
                            onClick={primaryAction.onSelect}
                            disabled={
                              pendingOpportunityId === opportunity.id ||
                              !canEdit ||
                              (primaryAction.requiresProjectManage && !canManageProjects)
                            }
                          >
                            {pendingOpportunityId === opportunity.id ? "Working..." : primaryAction.label}
                          </DropdownMenuItem>
                        )}
                        {!canEdit && (
                          <DropdownMenuItem disabled>
                            You do not have edit access
                          </DropdownMenuItem>
                        )}
                        {!canManageProjects && primaryAction?.requiresProjectManage && (
                          <DropdownMenuItem disabled>
                            Project access required
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                  </TableRow>
                )
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
