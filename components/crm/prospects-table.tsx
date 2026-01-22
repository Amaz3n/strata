"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Filter, MoreHorizontal, Plus, Search, Clock, AlertTriangle } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"
import { formatDistanceToNow, isPast, isToday } from "date-fns"

interface ProspectsTableProps {
  prospects: Prospect[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
}

export function ProspectsTable({
  prospects,
  teamMembers,
  canCreate = false,
  canEdit = false,
}: ProspectsTableProps) {
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<LeadStatus | undefined>()
  const [priorityFilter, setPriorityFilter] = useState<LeadPriority | undefined>()
  const [ownerFilter, setOwnerFilter] = useState<string | undefined>()
  const [addOpen, setAddOpen] = useState(false)
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)

  // Action dialogs
  const [touchContact, setTouchContact] = useState<Prospect | undefined>()
  const [followUpContact, setFollowUpContact] = useState<Prospect | undefined>()
  const [statusContact, setStatusContact] = useState<Prospect | undefined>()

  const router = useRouter()
  const { toast } = useToast()

  const filtered = useMemo(() => {
    return prospects
      .filter((p) => !statusFilter || p.lead_status === statusFilter)
      .filter((p) => !priorityFilter || p.lead_priority === priorityFilter)
      .filter((p) => !ownerFilter || p.lead_owner_user_id === ownerFilter)
      .filter((p) => {
        if (!search.trim()) return true
        const term = search.toLowerCase()
        return (
          p.full_name.toLowerCase().includes(term) ||
          p.email?.toLowerCase().includes(term) ||
          p.phone?.toLowerCase().includes(term)
        )
      })
  }, [prospects, statusFilter, priorityFilter, ownerFilter, search])

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

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
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

        <div className="flex items-center gap-2">
          {canCreate && (
            <Button onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add prospect
            </Button>
          )}
        </div>
      </div>

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

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Prospects ({filtered.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Follow-up</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((prospect) => {
                const followUpStatus = getFollowUpStatus(prospect.next_follow_up_at)
                return (
                  <TableRow key={prospect.id}>
                    <TableCell className="font-medium">
                      <button
                        className="text-left hover:underline"
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
                          className={`flex items-center gap-1 text-sm ${
                            followUpStatus === "overdue"
                              ? "text-red-600 dark:text-red-400"
                              : followUpStatus === "today"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground"
                          }`}
                        >
                          {followUpStatus === "overdue" && <AlertTriangle className="h-3 w-3" />}
                          {followUpStatus === "today" && <Clock className="h-3 w-3" />}
                          {formatDistanceToNow(new Date(prospect.next_follow_up_at), { addSuffix: true })}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{prospect.phone || "—"}</TableCell>
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
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-10">
                    No prospects match your filters.
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
