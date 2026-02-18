"use client"

import { useEffect, useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { TeamMember } from "@/lib/types"
import type { Prospect } from "@/lib/services/crm"
import type { LeadStatus, LeadPriority } from "@/lib/validation/crm"
import { LeadStatusBadge, LeadPriorityBadge } from "./lead-status-badge"
import { AddProspectDialog } from "./add-prospect-dialog"
import { ProspectDetailSheet } from "./prospect-detail-sheet"
import { AddTouchDialog } from "./add-touch-dialog"
import { FollowUpDialog } from "./follow-up-dialog"
import { ChangeStatusDialog } from "./change-status-dialog"
import { changeLeadStatusAction } from "@/app/(app)/pipeline/actions"
import {
  Filter,
  MoreHorizontal,
  Plus,
  Search,
  Clock,
  AlertTriangle,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Users,
  Zap,
  MessageSquare,
} from "@/components/icons"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow, isPast, isToday, differenceInDays } from "date-fns"
import { cn } from "@/lib/utils"

interface ProspectsTableProps {
  prospects: Prospect[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
  initialStatusFilter?: LeadStatus
  headerLeft?: ReactNode
}

type SortField = "name" | "status" | "priority" | "followUp" | "lastTouched" | "created"
type SortDirection = "asc" | "desc"

export function ProspectsTable({
  prospects,
  teamMembers,
  canCreate = false,
  canEdit = false,
  initialStatusFilter,
  headerLeft,
}: ProspectsTableProps) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<LeadStatus | undefined>(initialStatusFilter)
  const [priorityFilter, setPriorityFilter] = useState<LeadPriority | undefined>()
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>()
  const [addOpen, setAddOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)

  // Sorting state
  const [sortField, setSortField] = useState<SortField>("created")
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc")

  // Selection state for bulk actions
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Action dialogs
  const [touchContact, setTouchContact] = useState<Prospect | undefined>()
  const [followUpContact, setFollowUpContact] = useState<Prospect | undefined>()
  const [statusContact, setStatusContact] = useState<Prospect | undefined>()

  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const { toast } = useToast()

  useEffect(() => {
    setStatusFilter(initialStatusFilter)
  }, [initialStatusFilter])

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc")
    } else {
      setSortField(field)
      setSortDirection("asc")
    }
  }

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 opacity-50" />
    return sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
  }

  const filtered = useMemo(() => {
    let result = prospects
      .filter((p) => !statusFilter || p.lead_status === statusFilter)
      .filter((p) => !priorityFilter || p.lead_priority === priorityFilter)
      .filter((p) => {
        if (!ownerFilter) return true
        if (ownerFilter === "unassigned") return !p.lead_owner_user_id
        return p.lead_owner_user_id === ownerFilter
      })
      .filter((p) => {
        if (!search.trim()) return true
        const term = search.toLowerCase()
        return (
          p.full_name.toLowerCase().includes(term) ||
          p.email?.toLowerCase().includes(term) ||
          p.phone?.toLowerCase().includes(term)
        )
      })

    // Sort
    result = [...result].sort((a, b) => {
      let comparison = 0
      switch (sortField) {
        case "name":
          comparison = a.full_name.localeCompare(b.full_name)
          break
        case "status":
          comparison = (a.lead_status ?? "new").localeCompare(b.lead_status ?? "new")
          break
        case "priority":
          const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 }
          comparison = (priorityOrder[a.lead_priority ?? "normal"] ?? 2) - (priorityOrder[b.lead_priority ?? "normal"] ?? 2)
          break
        case "followUp":
          const aDate = a.next_follow_up_at ?? "9999"
          const bDate = b.next_follow_up_at ?? "9999"
          comparison = aDate.localeCompare(bDate)
          break
        case "lastTouched":
          const aTouch = a.last_contacted_at ?? "0000"
          const bTouch = b.last_contacted_at ?? "0000"
          comparison = bTouch.localeCompare(aTouch) // Most recent first
          break
        case "created":
          comparison = b.created_at.localeCompare(a.created_at)
          break
      }
      return sortDirection === "asc" ? comparison : -comparison
    })

    return result
  }, [prospects, statusFilter, priorityFilter, ownerFilter, search, sortField, sortDirection])

  const openDetail = (prospectId: string) => {
    setDetailId(prospectId)
    setDetailOpen(true)
  }

  const getOwnerName = (userId?: string) => {
    if (!userId) return "Unassigned"
    return teamMembers.find((m) => m.user.id === userId)?.user.full_name ?? "Unknown"
  }

  const getFollowUpStatus = (dateStr?: string | null) => {
    if (!dateStr) return null
    const date = new Date(dateStr)
    if (isPast(date) && !isToday(date)) return "overdue"
    if (isToday(date)) return "today"
    return "upcoming"
  }

  const isStale = (lastTouched?: string | null) => {
    if (!lastTouched) return false
    return differenceInDays(new Date(), new Date(lastTouched)) > 7
  }

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((p) => p.id)))
    }
  }

  const toggleSelect = (id: string) => {
    const newSelected = new Set(selected)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelected(newSelected)
  }

  const handleBulkStatusChange = (status: LeadStatus) => {
    if (selected.size === 0) return
    startTransition(async () => {
      try {
        for (const id of selected) {
          await changeLeadStatusAction({ contact_id: id, lead_status: status })
        }
        router.refresh()
        toast({ title: `Updated ${selected.size} prospects to ${status}` })
        setSelected(new Set())
      } catch (error) {
        toast({ title: "Failed to update", description: (error as Error).message })
      }
    })
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>{headerLeft}</div>
        {canCreate && (
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add prospect
          </Button>
        )}
      </div>

      <div className="flex items-center gap-2 w-full md:w-auto">
        <div className="relative w-full md:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search prospects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Filters */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Status
          </Label>
          <Select
            value={statusFilter ?? "all"}
            onValueChange={(v) => setStatusFilter(v === "all" ? undefined : (v as LeadStatus))}
          >
            <SelectTrigger>
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="new">New</SelectItem>
              <SelectItem value="contacted">Contacted</SelectItem>
              <SelectItem value="qualified">Qualified</SelectItem>
              <SelectItem value="estimating">Estimating</SelectItem>
              <SelectItem value="won">Won</SelectItem>
              <SelectItem value="lost">Lost</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Priority
          </Label>
          <Select
            value={priorityFilter ?? "all"}
            onValueChange={(v) => setPriorityFilter(v === "all" ? undefined : (v as LeadPriority))}
          >
            <SelectTrigger>
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="urgent">Urgent</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3 w-3" />
            Owner
          </Label>
          <Select
            value={ownerFilter ?? "all"}
            onValueChange={(v) => setOwnerFilter(v === "all" ? undefined : v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="All owners" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
              {teamMembers.map((m) => (
                <SelectItem key={m.user.id} value={m.user.id}>
                  {m.user.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bulk actions bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                Change status
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => handleBulkStatusChange("new")}>New</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBulkStatusChange("contacted")}>Contacted</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBulkStatusChange("qualified")}>Qualified</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBulkStatusChange("estimating")}>Estimating</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => handleBulkStatusChange("won")}>Won</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleBulkStatusChange("lost")}>Lost</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {/* Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Prospects ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                {canEdit && (
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selected.size === filtered.length && filtered.length > 0}
                      onCheckedChange={toggleSelectAll}
                    />
                  </TableHead>
                )}
                <TableHead>
                  <button
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                    onClick={() => toggleSort("name")}
                  >
                    Name {getSortIcon("name")}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                    onClick={() => toggleSort("status")}
                  >
                    Status {getSortIcon("status")}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                    onClick={() => toggleSort("priority")}
                  >
                    Priority {getSortIcon("priority")}
                  </button>
                </TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>
                  <button
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                    onClick={() => toggleSort("followUp")}
                  >
                    Follow-up {getSortIcon("followUp")}
                  </button>
                </TableHead>
                <TableHead>
                  <button
                    className="flex items-center gap-1 hover:text-foreground transition-colors"
                    onClick={() => toggleSort("lastTouched")}
                  >
                    Last touched {getSortIcon("lastTouched")}
                  </button>
                </TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((prospect) => {
                const followUpStatus = getFollowUpStatus(prospect.next_follow_up_at)
                const stale = isStale(prospect.last_contacted_at)
                return (
                  <TableRow key={prospect.id} className={cn(stale && "bg-amber-50/50 dark:bg-amber-950/20")}>
                    {canEdit && (
                      <TableCell>
                        <Checkbox
                          checked={selected.has(prospect.id)}
                          onCheckedChange={() => toggleSelect(prospect.id)}
                        />
                      </TableCell>
                    )}
                    <TableCell className="font-medium">
                      <button
                        className="text-left hover:underline hover:text-primary transition-colors"
                        onClick={() => openDetail(prospect.id)}
                      >
                        {prospect.full_name}
                      </button>
                      {prospect.crm_source && (
                        <div className="text-xs text-muted-foreground">{prospect.crm_source}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <LeadStatusBadge status={prospect.lead_status ?? "new"} />
                    </TableCell>
                    <TableCell>
                      <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {getOwnerName(prospect.lead_owner_user_id)}
                    </TableCell>
                    <TableCell>
                      {prospect.next_follow_up_at ? (
                        <div
                          className={cn(
                            "flex items-center gap-1 text-sm",
                            followUpStatus === "overdue" && "text-red-600 dark:text-red-400",
                            followUpStatus === "today" && "text-amber-600 dark:text-amber-400"
                          )}
                        >
                          {followUpStatus === "overdue" && <AlertTriangle className="h-3 w-3" />}
                          {followUpStatus === "today" && <Clock className="h-3 w-3" />}
                          {formatDistanceToNow(new Date(prospect.next_follow_up_at), { addSuffix: true })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {prospect.last_contacted_at ? (
                        <div className={cn("flex items-center gap-1 text-sm", stale && "text-amber-600 dark:text-amber-400")}>
                          {stale && <MessageSquare className="h-3 w-3" />}
                          {formatDistanceToNow(new Date(prospect.last_contacted_at), { addSuffix: true })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic text-sm">Never</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuLabel>Actions</DropdownMenuLabel>
                          <DropdownMenuItem onClick={() => openDetail(prospect.id)}>
                            View details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canEdit}
                            onClick={() => setTouchContact(prospect)}
                          >
                            Add activity
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canEdit}
                            onClick={() => setFollowUpContact(prospect)}
                          >
                            Set follow-up
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={!canEdit}
                            onClick={() => setStatusContact(prospect)}
                          >
                            Change status
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem asChild>
                            <Link href={`/estimates?recipient=${prospect.id}`}>
                              Create estimate
                            </Link>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canEdit ? 8 : 7} className="h-40">
                    <div className="flex flex-col items-center justify-center text-center">
                      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
                        <Users className="h-6 w-6 text-muted-foreground" />
                      </div>
                      {search || statusFilter || priorityFilter || ownerFilter ? (
                        <>
                          <p className="text-sm font-medium">No matches found</p>
                          <p className="text-xs text-muted-foreground mt-1">Try adjusting your filters</p>
                          <Button
                            variant="link"
                            size="sm"
                            className="mt-2"
                            onClick={() => {
                              setSearch("")
                              setStatusFilter(undefined)
                              setPriorityFilter(undefined)
                              setOwnerFilter(undefined)
                            }}
                          >
                            Clear all filters
                          </Button>
                        </>
                      ) : (
                        <>
                          <p className="text-sm font-medium">No prospects yet</p>
                          <p className="text-xs text-muted-foreground mt-1">Add your first prospect to get started</p>
                          {canCreate && (
                            <Button size="sm" className="mt-3" onClick={() => setAddOpen(true)}>
                              <Zap className="h-4 w-4 mr-2" />
                              Add prospect
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <AddProspectDialog open={addOpen} onOpenChange={setAddOpen} teamMembers={teamMembers} />
      <ProspectDetailSheet
        contactId={detailId}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        teamMembers={teamMembers}
      />

      {touchContact && (
        <AddTouchDialog
          open={!!touchContact}
          onOpenChange={(open) => !open && setTouchContact(undefined)}
          contactId={touchContact.id}
          contactName={touchContact.full_name}
        />
      )}

      {followUpContact && (
        <FollowUpDialog
          open={!!followUpContact}
          onOpenChange={(open) => !open && setFollowUpContact(undefined)}
          contactId={followUpContact.id}
          contactName={followUpContact.full_name}
          currentFollowUp={followUpContact.next_follow_up_at}
        />
      )}

      {statusContact && (
        <ChangeStatusDialog
          open={!!statusContact}
          onOpenChange={(open) => !open && setStatusContact(undefined)}
          contactId={statusContact.id}
          contactName={statusContact.full_name}
          currentStatus={statusContact.lead_status ?? "new"}
        />
      )}
    </div>
  )
}
