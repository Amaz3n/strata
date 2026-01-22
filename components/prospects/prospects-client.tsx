"use client"

import { useMemo, useState, useTransition } from "react"
import { format } from "date-fns"
import { toast } from "sonner"

import type { Prospect } from "@/lib/services/crm"
import type { TeamMember } from "@/lib/types"
import type { LeadStatus } from "@/lib/validation/crm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Plus, MoreHorizontal, Users, Mail, MessageSquare, Calendar } from "@/components/icons"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { AddProspectDialog } from "@/components/pipeline/add-prospect-dialog"
import { ProspectDetailSheet } from "@/components/pipeline/prospect-detail-sheet"
import { AddTouchDialog } from "@/components/pipeline/add-touch-dialog"
import { FollowUpDialog } from "@/components/pipeline/follow-up-dialog"
import { ChangeStatusDialog } from "@/components/pipeline/change-status-dialog"
import { LeadStatusBadge, LeadPriorityBadge } from "@/components/pipeline/lead-status-badge"
import Link from "next/link"

type StatusKey = "new" | "contacted" | "qualified" | "estimating" | "won" | "lost"

const statusLabels: Record<StatusKey, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  estimating: "Estimating",
  won: "Won",
  lost: "Lost",
}

const statusStyles: Record<StatusKey, string> = {
  new: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  contacted: "bg-slate-400/15 text-slate-600 border-slate-400/30",
  qualified: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  estimating: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  won: "bg-success/15 text-success border-success/30",
  lost: "bg-red-500/15 text-red-600 border-red-500/30",
}

interface ProspectsClientProps {
  prospects: Prospect[]
  teamMembers: TeamMember[]
  canCreate?: boolean
  canEdit?: boolean
}

export function ProspectsClient({
  prospects,
  teamMembers,
  canCreate = false,
  canEdit = false
}: ProspectsClientProps) {
  const [items, setItems] = useState(prospects)
  const [search, setSearch] = useState("")
  const [statusFilter, setStatusFilter] = useState<"all" | StatusKey>("all")
  const [ownerFilter, setOwnerFilter] = useState("all")
  const [createOpen, setCreateOpen] = useState(false)

  // Dialog states
  const [detailId, setDetailId] = useState<string | undefined>()
  const [detailOpen, setDetailOpen] = useState(false)
  const [touchContact, setTouchContact] = useState<Prospect | undefined>()
  const [followUpContact, setFollowUpContact] = useState<Prospect | undefined>()
  const [statusContact, setStatusContact] = useState<Prospect | undefined>()

  const [creating, startCreating] = useTransition()

  const filtered = useMemo(() => {
    const term = search.toLowerCase()
    return items.filter((p) => {
      const matchesStatus = statusFilter === "all" || (p.lead_status ?? "new") === statusFilter
      const matchesOwner =
        ownerFilter === "all" ||
        (ownerFilter === "unassigned" ? !p.lead_owner_user_id : p.lead_owner_user_id === ownerFilter)
      const haystack = [p.full_name, p.email ?? "", p.phone ?? "", p.crm_source ?? ""].join(" ").toLowerCase()
      const matchesSearch = !term || haystack.includes(term)
      return matchesStatus && matchesOwner && matchesSearch
    })
  }, [items, statusFilter, ownerFilter, search])

  function resolveStatus(status?: string | null): StatusKey {
    if (status && status in statusLabels) return status as StatusKey
    return "new"
  }

  const openDetail = (prospectId: string) => {
    setDetailId(prospectId)
    setDetailOpen(true)
  }

  const getOwnerName = (userId?: string) => {
    if (!userId) return "Unassigned"
    return teamMembers.find((m) => m.user.id === userId)?.user.full_name ?? "Unknown"
  }

  return (
    <div className="space-y-4">
      <AddProspectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        teamMembers={teamMembers}
      />

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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 items-center gap-2">
          <Input
            placeholder="Search prospects..."
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
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as any)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {(["new", "contacted", "qualified", "estimating", "won", "lost"] as StatusKey[]).map((status) => (
                <SelectItem key={status} value={status}>
                  {statusLabels[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {canCreate && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add prospect
          </Button>
        )}
      </div>

      <div className="rounded-lg border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="divide-x">
              <TableHead className="px-4 py-4">Name</TableHead>
              <TableHead className="px-4 py-4">Contact</TableHead>
              <TableHead className="px-4 py-4 text-center">Status</TableHead>
              <TableHead className="px-4 py-4 text-center">Priority</TableHead>
              <TableHead className="px-4 py-4">Owner</TableHead>
              <TableHead className="px-4 py-4 text-center">Next Follow-up</TableHead>
              <TableHead className="px-4 py-4 text-center">Last Touched</TableHead>
              <TableHead className="text-center w-12 px-4 py-4">‎</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((prospect) => {
              const statusKey = resolveStatus(prospect.lead_status)
              return (
                <TableRow key={prospect.id} className="divide-x">
                  <TableCell className="px-4 py-4">
                    <button
                      className="text-left hover:underline hover:text-primary transition-colors font-semibold"
                      onClick={() => openDetail(prospect.id)}
                    >
                      {prospect.full_name}
                    </button>
                    {prospect.crm_source && (
                      <div className="text-sm text-muted-foreground">{prospect.crm_source}</div>
                    )}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm">
                    <div>{prospect.email || prospect.phone || "—"}</div>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <Badge variant="secondary" className={`border ${statusStyles[statusKey]}`}>
                      {statusLabels[statusKey]}
                    </Badge>
                  </TableCell>
                  <TableCell className="px-4 py-4 text-center">
                    <LeadPriorityBadge priority={prospect.lead_priority ?? "normal"} />
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground">
                    {getOwnerName(prospect.lead_owner_user_id)}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {prospect.next_follow_up_at ? format(new Date(prospect.next_follow_up_at), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="px-4 py-4 text-muted-foreground text-sm text-center">
                    {prospect.last_contacted_at ? format(new Date(prospect.last_contacted_at), "MMM d, yyyy") : "—"}
                  </TableCell>
                  <TableCell className="text-center w-12 px-4 py-4">
                    <div className="flex justify-center">
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
                          {canEdit && (
                            <>
                              <DropdownMenuItem onClick={() => setTouchContact(prospect)}>
                                <MessageSquare className="mr-2 h-4 w-4" />
                                Add activity
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setFollowUpContact(prospect)}>
                                <Calendar className="mr-2 h-4 w-4" />
                                Set follow-up
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setStatusContact(prospect)}>
                                <Mail className="mr-2 h-4 w-4" />
                                Change status
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {filtered.length === 0 && (
              <TableRow className="divide-x">
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  <div className="flex flex-col items-center gap-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                      <Users className="h-6 w-6" />
                    </div>
                    <div>
                      <p className="font-medium">No prospects found</p>
                      <p className="text-sm">Try adjusting your filters or add a new prospect.</p>
                    </div>
                    {canCreate && (
                      <Button onClick={() => setCreateOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" />
                        Add prospect
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}