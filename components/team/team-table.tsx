"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TeamMember } from "@/lib/types"
import { MemberRoleBadge } from "@/components/team/member-role-badge"
import { EditMemberDialog } from "@/components/team/edit-member-dialog"
import {
  reactivateMemberAction,
  removeMemberAction,
  resendInviteAction,
  suspendMemberAction,
} from "@/app/(app)/team/actions"
import { MoreHorizontal, Users } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

const statusColors: Record<string, string> = {
  active: "bg-success/20 text-success border-success/30",
  invited: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  suspended: "bg-muted text-muted-foreground border-border",
}

const statusLabels: Record<string, string> = {
  active: "Active",
  invited: "Pending",
  suspended: "Archived",
}

function getInitials(name: string | null | undefined): string {
  if (!name) return "?"
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

interface TeamTableProps {
  members: TeamMember[]
  canManageMembers?: boolean
  canEditRoles?: boolean
  showProjectCounts?: boolean
  onMemberChange?: () => void
}

export function TeamTable({
  members,
  canManageMembers = false,
  canEditRoles = false,
  showProjectCounts = true,
  onMemberChange,
}: TeamTableProps) {
  const [isPending, startTransition] = useTransition()
  const [view, setView] = useState<"active" | "archived">("active")
  const { toast } = useToast()
  const router = useRouter()

  const refreshData = () => {
    if (onMemberChange) {
      onMemberChange()
    } else {
      router.refresh()
    }
  }

  const suspend = (membershipId: string) => {
    if (!canManageMembers) {
      toast({ title: "Permission required", description: "You need member management access to suspend users." })
      return
    }

    startTransition(async () => {
      try {
        await suspendMemberAction(membershipId)
        toast({ title: "Member archived" })
        refreshData()
      } catch (error) {
        toast({ title: "Unable to suspend", description: (error as Error).message })
      }
    })
  }

  const reactivate = (membershipId: string) => {
    if (!canManageMembers) {
      toast({ title: "Permission required", description: "You need member management access to reactivate users." })
      return
    }

    startTransition(async () => {
      try {
        await reactivateMemberAction(membershipId)
        toast({ title: "Member restored" })
        refreshData()
      } catch (error) {
        toast({ title: "Unable to reactivate", description: (error as Error).message })
      }
    })
  }

  const remove = (membershipId: string) => {
    if (!canManageMembers) {
      toast({ title: "Permission required", description: "You need member management access to remove users." })
      return
    }

    startTransition(async () => {
      try {
        await removeMemberAction(membershipId)
        toast({ title: "Member removed" })
        refreshData()
      } catch (error) {
        toast({ title: "Unable to remove", description: (error as Error).message })
      }
    })
  }

  const resend = (membershipId: string) => {
    if (!canManageMembers) {
      toast({ title: "Permission required", description: "You need member management access to resend invites." })
      return
    }

    startTransition(async () => {
      try {
        await resendInviteAction(membershipId)
        toast({ title: "Invite resent" })
        refreshData()
      } catch (error) {
        toast({ title: "Unable to resend invite", description: (error as Error).message })
      }
    })
  }

  const activeMembers = useMemo(
    () => members.filter((member) => member.status !== "suspended"),
    [members],
  )
  const archivedMembers = useMemo(
    () => members.filter((member) => member.status === "suspended"),
    [members],
  )
  const visibleMembers = view === "archived" ? archivedMembers : activeMembers
  const colSpan = 4 + (showProjectCounts ? 1 : 0) + (canManageMembers || canEditRoles ? 1 : 0)

  const emptyTitle = view === "archived"
    ? "No archived members"
    : members.length > 0
      ? "No active members"
      : "No team members yet"
  const emptyDescription = view === "archived"
    ? "Archived teammates will appear here."
    : members.length > 0
      ? "Invite or restore a teammate to continue."
      : "Invite your first team member to get started."

  return (
    <div className="rounded-lg border px-6 py-3">
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Team members</p>
          <p className="text-xs text-muted-foreground">Review teammates, access levels, and activity.</p>
        </div>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(next) => next && setView(next as "active" | "archived")}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="active">Active ({activeMembers.length})</ToggleGroupItem>
          <ToggleGroupItem value="archived">Archived ({archivedMembers.length})</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[280px]">Member</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Status</TableHead>
            {showProjectCounts && <TableHead className="text-center">Projects</TableHead>}
            <TableHead>Last active</TableHead>
            {(canManageMembers || canEditRoles) && <TableHead className="w-[120px] text-right">Actions</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {visibleMembers.map((member) => (
            <TableRow key={member.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <Avatar className="h-9 w-9">
                    <AvatarImage src={member.user.avatar_url || undefined} alt={member.user.full_name || ""} />
                    <AvatarFallback className="text-xs font-medium">
                      {getInitials(member.user.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex flex-col min-w-0">
                    <span className="font-semibold truncate">{member.user.full_name || "Unknown"}</span>
                    <span className="text-xs text-muted-foreground truncate">{member.user.email}</span>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <MemberRoleBadge role={member.role} />
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={statusColors[member.status] || ""}>
                  {statusLabels[member.status] || member.status}
                </Badge>
              </TableCell>
              {showProjectCounts && (
                <TableCell className="text-center text-muted-foreground">
                  {member.project_count ?? 0}
                </TableCell>
              )}
              <TableCell className="text-sm text-muted-foreground">
                {member.last_active_at ? new Date(member.last_active_at).toLocaleDateString() : "—"}
              </TableCell>
              {(canManageMembers || canEditRoles) && (
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                        <span className="sr-only">Actions</span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>Actions</DropdownMenuLabel>
                      <EditMemberDialog
                        member={member}
                        canManageMembers={canManageMembers}
                        canEditRoles={canEditRoles}
                        onSuccess={refreshData}
                        trigger={
                          <DropdownMenuItem disabled={!canManageMembers && !canEditRoles}>
                            Edit member
                          </DropdownMenuItem>
                        }
                      />
                      <DropdownMenuSeparator />
                      {member.status === "suspended" ? (
                        <DropdownMenuItem disabled={isPending || !canManageMembers} onClick={() => reactivate(member.id)}>
                          Restore member
                        </DropdownMenuItem>
                      ) : member.status === "invited" ? (
                        <DropdownMenuItem disabled={isPending || !canManageMembers} onClick={() => resend(member.id)}>
                          Resend invite
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem disabled={isPending || !canManageMembers} onClick={() => suspend(member.id)}>
                          Archive member
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive"
                        disabled={isPending || !canManageMembers}
                        onClick={() => remove(member.id)}
                      >
                        Remove
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              )}
            </TableRow>
          ))}
          {visibleMembers.length === 0 && (
            <TableRow>
              <TableCell colSpan={colSpan} className="text-center py-12 text-muted-foreground">
                <div className="flex flex-col items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                    <Users className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="font-medium">{emptyTitle}</p>
                    <p className="text-sm">{emptyDescription}</p>
                  </div>
                </div>
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
