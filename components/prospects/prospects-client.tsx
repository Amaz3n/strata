"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { format } from "date-fns"

import type { Prospect } from "@/lib/services/prospects"
import type { ProspectStatus } from "@/lib/validation/prospects"
import type { TeamMember } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AddProspectDialog } from "@/components/pipeline/add-prospect-dialog"
import { ProspectDetailSheet } from "@/components/pipeline/prospect-detail-sheet"
import {
  PipelineAttentionStrip,
  type AttentionCounts,
  type AttentionFilter,
} from "@/components/pipeline/pipeline-attention-strip"
import { deleteProspectAction } from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { formatMoneyCents } from "@/lib/utils"
import { ChevronLeft, ChevronRight, Edit, Filter, MoreHorizontal, Plus, Search, Trash2, Users, X } from "@/components/icons"

export type ProspectTableFilter = "active" | "all" | ProspectStatus | "stalled" | "followup_due"

/** Statuses considered open/in-flight. Closed states (won, lost) are excluded from the default view. */
const ACTIVE_STATUSES = new Set<ProspectStatus>([
  "new",
  "contacted",
  "qualified",
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
  "executed",
])

const PAGE_SIZE = 25

function formatBudgetRange(budget?: string | null): string {
  const map: Record<string, string> = {
    under_100k: "Under $100k",
    "100k_250k": "$100k – $250k",
    "250k_500k": "$250k – $500k",
    "500k_1m": "$500k – $1M",
    over_1m: "Over $1M",
    undecided: "Undecided",
  }
  return map[budget ?? ""] ?? ""
}

const statusLabels: Record<ProspectStatus, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  pricing: "Pricing",
  estimate_sent: "Estimate sent",
  changes_requested: "Changes requested",
  client_approved: "Client approved",
  executed: "Executed",
  won: "Won",
  lost: "Lost",
}

const statusStyles: Record<ProspectStatus, string> = {
  new: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  contacted: "bg-slate-400/15 text-slate-600 border-slate-400/30",
  qualified: "bg-violet-500/15 text-violet-600 border-violet-500/30",
  pricing: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  estimate_sent: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  changes_requested: "bg-orange-500/15 text-orange-600 border-orange-500/30",
  client_approved: "bg-cyan-500/15 text-cyan-600 border-cyan-500/30",
  executed: "bg-green-500/15 text-green-600 border-green-500/30",
  won: "bg-success/15 text-success border-success/30",
  lost: "bg-red-500/15 text-red-600 border-red-500/30",
}

const filterLabels: Record<ProspectTableFilter, string> = {
  ...statusLabels,
  active: "Active",
  all: "All prospects",
  stalled: "Stalled",
  followup_due: "Follow-ups due",
}

// Order shown in the Status section of the Filter dropdown.
const STATUS_FILTER_OPTIONS: ProspectTableFilter[] = [
  "active",
  "all",
  "followup_due",
  "stalled",
  "new",
  "contacted",
  "qualified",
  "pricing",
  "estimate_sent",
  "changes_requested",
  "client_approved",
  "executed",
  "won",
  "lost",
]

interface ProspectsClientProps {
  prospects: Prospect[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
  attentionCounts: AttentionCounts
  /** Controlled status/derived filter, driven by the funnel above and the badges/filter here. */
  activeFilter: ProspectTableFilter
  onSelectFilter: (filter: ProspectTableFilter) => void
  onClearFilter: () => void
  /** Prospect ids considered stalled, computed server-side. Used for the "stalled" filter. */
  stalledIds: Set<string>
  /** Prospect ids with a follow-up due today or overdue. Used for the "followup_due" filter. */
  followUpDueIds: Set<string>
  onAddProspect?: () => void
}

function primaryName(prospect: Prospect) {
  return prospect.primary_contact?.full_name ?? prospect.contacts?.[0]?.full_name ?? "No contact"
}

function primaryContactLine(prospect: Prospect) {
  const contact = prospect.primary_contact ?? prospect.contacts?.[0]
  return contact?.email || contact?.phone || "No contact info"
}

export function ProspectsClient({
  prospects,
  teamMembers,
  canCreate = false,
  canEdit = false,
  attentionCounts,
  activeFilter,
  onSelectFilter,
  onClearFilter,
  stalledIds,
  followUpDueIds,
  onAddProspect,
}: ProspectsClientProps) {
  const router = useRouter()
  // Badges toggle the same controlled filter; re-selecting the active one returns to the default view.
  const toggleAttention = (next: AttentionFilter) => onSelectFilter(activeFilter === next ? "active" : next)
  const attentionActive =
    activeFilter !== "active" && activeFilter !== "all" ? (activeFilter as AttentionFilter) : null
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [search, setSearch] = useState("")
  const [ownerFilter, setOwnerFilter] = useState("all")
  const [page, setPage] = useState(1)
  const [editProspect, setEditProspect] = useState<Prospect | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Prospect | null>(null)
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)

  const handleDelete = () => {
    if (!deleteTarget) return
    const target = deleteTarget
    startTransition(async () => {
      try {
        await deleteProspectAction(target.id)
        toast({ title: "Prospect deleted" })
        setDeleteTarget(null)
        router.refresh()
      } catch (error) {
        toast({ title: "Failed to delete prospect", description: (error as Error).message })
      }
    })
  }

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return prospects.filter((prospect) => {
      const matchesFilter =
        activeFilter === "all"
          ? true
          : activeFilter === "active"
            ? ACTIVE_STATUSES.has(prospect.status)
            : activeFilter === "stalled"
              ? stalledIds.has(prospect.id)
              : activeFilter === "followup_due"
                ? followUpDueIds.has(prospect.id)
                : prospect.status === activeFilter
      const matchesOwner =
        ownerFilter === "all"
          ? true
          : ownerFilter === "unassigned"
            ? !prospect.owner_user_id
            : prospect.owner_user_id === ownerFilter
      const haystack = [
        prospect.name,
        prospect.source ?? "",
        prospect.project_type ?? "",
        primaryName(prospect),
        primaryContactLine(prospect),
      ]
        .join(" ")
        .toLowerCase()
      return matchesFilter && matchesOwner && (!term || haystack.includes(term))
    })
  }, [activeFilter, followUpDueIds, ownerFilter, prospects, search, stalledIds])

  // Reset to the first page whenever the result set changes underneath us.
  useEffect(() => {
    setPage(1)
  }, [activeFilter, ownerFilter, search])

  const activeFilterCount = (activeFilter !== "active" ? 1 : 0) + (ownerFilter !== "all" ? 1 : 0)

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount)
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage],
  )

  const openDetail = (prospectId: string) => {
    setDetailId(prospectId)
    setDetailOpen(true)
  }

  const getOwnerName = (userId?: string | null) => {
    if (!userId) return "Unassigned"
    return teamMembers.find((m) => m.user.id === userId)?.user.full_name ?? "Unknown"
  }

  return (
    <div className="space-y-3">
      <AddProspectDialog
        open={Boolean(editProspect)}
        onOpenChange={(open) => !open && setEditProspect(null)}
        teamMembers={teamMembers}
        prospect={editProspect}
      />
      <ProspectDetailSheet prospectId={detailId} open={detailOpen} onOpenChange={setDetailOpen} teamMembers={teamMembers} />

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete prospect?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes <span className="font-medium text-foreground">{deleteTarget?.name}</span> and its
              contacts. Any estimates or bids stay but are unlinked from this prospect. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(event) => {
                event.preventDefault()
                handleDelete()
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search prospects..."
              className="pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Filter className="h-4 w-4" />
                Filter
                {activeFilterCount > 0 ? (
                  <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold tabular-nums text-primary-foreground">
                    {activeFilterCount}
                  </span>
                ) : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>Status</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={activeFilter}
                onValueChange={(value) => onSelectFilter(value as ProspectTableFilter)}
              >
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <DropdownMenuRadioItem key={option} value={option}>
                    {filterLabels[option]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Assigned to</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={ownerFilter} onValueChange={setOwnerFilter}>
                <DropdownMenuRadioItem value="all">Anyone</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unassigned">Unassigned</DropdownMenuRadioItem>
                {teamMembers.map((member) => (
                  <DropdownMenuRadioItem key={member.user.id} value={member.user.id}>
                    {member.user.full_name}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              {activeFilterCount > 0 ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      onClearFilter()
                      setOwnerFilter("all")
                    }}
                  >
                    <X className="mr-2 h-4 w-4" />
                    Reset filters
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <PipelineAttentionStrip counts={attentionCounts} activeFilter={attentionActive} onSelect={toggleAttention} />
        </div>
        {canCreate && onAddProspect ? (
          <Button onClick={onAddProspect} className="shrink-0">
            <Plus className="mr-2 h-4 w-4" />
            Add prospect
          </Button>
        ) : null}
      </div>

      <div className="overflow-hidden border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-4 py-3.5">Prospect</TableHead>
              <TableHead className="px-4 py-3.5">Primary contact</TableHead>
              <TableHead className="px-4 py-3.5">Status</TableHead>
              <TableHead className="px-4 py-3.5">Assigned to</TableHead>
              <TableHead className="px-4 py-3.5 text-right">Value</TableHead>
              <TableHead className="px-4 py-3.5 text-right">Created</TableHead>
              <TableHead className="w-12 px-4 py-3.5" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.map((prospect) => (
              <TableRow key={prospect.id} className="group">
                <TableCell className="px-4 py-3.5">
                  <button
                    className="text-left font-semibold transition-colors hover:text-primary"
                    onClick={() => openDetail(prospect.id)}
                  >
                    {prospect.name}
                  </button>
                </TableCell>
                <TableCell className="px-4 py-3.5 text-sm text-muted-foreground">
                  <div className="font-medium text-foreground">{primaryName(prospect)}</div>
                  <div>{primaryContactLine(prospect)}</div>
                </TableCell>
                <TableCell className="px-4 py-3.5">
                  <Badge variant="secondary" className={`border ${statusStyles[prospect.status]}`}>
                    {statusLabels[prospect.status]}
                  </Badge>
                </TableCell>
                <TableCell className="px-4 py-3.5 text-muted-foreground">{getOwnerName(prospect.owner_user_id)}</TableCell>
                <TableCell className="px-4 py-3.5 text-right text-sm tabular-nums">
                  {prospect.estimate_value_cents ? (
                    <span className="font-medium">{formatMoneyCents(prospect.estimate_value_cents)}</span>
                  ) : prospect.budget_range && formatBudgetRange(prospect.budget_range) ? (
                    <span className="text-xs text-muted-foreground italic font-normal">
                      {formatBudgetRange(prospect.budget_range)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="px-4 py-3.5 text-right text-sm tabular-nums text-muted-foreground">
                  {format(new Date(prospect.created_at), "MMM d, yyyy")}
                </TableCell>
                <TableCell className="w-12 px-4 py-3.5 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Prospect actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openDetail(prospect.id)}>
                        <Users className="mr-2 h-4 w-4" />
                        View details
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={!canEdit} onClick={() => setEditProspect(prospect)}>
                        <Edit className="mr-2 h-4 w-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        disabled={!canEdit}
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteTarget(prospect)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-12 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Users className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">No prospects found</p>
                      <p className="text-sm">
                        {activeFilter === "active" || activeFilter === "all"
                          ? "Capture a lead to get started."
                          : "Nothing matches this filter."}
                      </p>
                    </div>
                    {activeFilter !== "active" && activeFilter !== "all" ? (
                      <Button variant="outline" onClick={onClearFilter}>
                        Clear filter
                      </Button>
                    ) : onAddProspect ? (
                      <Button onClick={onAddProspect}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add prospect
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between gap-3 px-1">
          <span className="text-xs text-muted-foreground">
            Showing {(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Prev
            </Button>
            <span className="px-1 text-xs tabular-nums text-muted-foreground">
              {currentPage} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={currentPage >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
