"use client"

import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
import { InviteMemberDialog } from "@/components/team/invite-member-dialog"
import {
  reactivateMemberAction,
  resetMemberMfaAction,
  removeMemberAction,
  resendInviteAction,
  suspendMemberAction,
} from "@/app/(app)/team/actions"
import { Lock, MoreHorizontal, UserPlus, Users } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import type { OrgRoleOption } from "@/lib/types"

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
  roleOptions?: OrgRoleOption[]
  showProjectCounts?: boolean
  onMemberChange?: () => void
}

export function TeamTable({
  members,
  canManageMembers = false,
  canEditRoles = false,
  roleOptions = [],
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

  const resetMfa = (membershipId: string) => {
    if (!canManageMembers) {
      toast({ title: "Permission required", description: "You need member management access to reset MFA." })
      return
    }

    const confirmed = window.confirm("Reset this member's MFA? They will need to set up authenticator access again.")
    if (!confirmed) return

    startTransition(async () => {
      try {
        const result = await resetMemberMfaAction(membershipId)
        toast({ title: result?.reset ? "MFA reset" : "No MFA to reset" })
        refreshData()
      } catch (error) {
        toast({ title: "Unable to reset MFA", description: (error as Error).message })
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
  const colSpan = 5 + (showProjectCounts ? 1 : 0) + (canManageMembers || canEditRoles ? 1 : 0)

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
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Select value={view} onValueChange={(next) => setView(next as "active" | "archived")}>
          <SelectTrigger className="h-9 w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active ({activeMembers.length})</SelectItem>
            <SelectItem value="archived">Archived ({archivedMembers.length})</SelectItem>
          </SelectContent>
        </Select>
        <InviteMemberDialog
          canInvite={canManageMembers}
          roleOptions={roleOptions}
          onSuccess={refreshData}
          trigger={
            <Button
              size="icon"
              variant="default"
              disabled={!canManageMembers}
              className="h-9 w-9"
            >
              <UserPlus className="h-4 w-4" />
              <span className="sr-only">Invite member</span>
            </Button>
          }
        />
      </div>
      <div className="rounded-lg border px-6 py-3">
        <TooltipProvider delayDuration={200}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[280px]">Member</TableHead>
                <TableHead className="text-center">Role</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-center">
                  <div className="inline-flex items-center justify-center gap-1">
                    MFA
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="inline-flex h-4 w-4 items-center justify-center text-muted-foreground">
                          <Lock className="h-3.5 w-3.5" />
                          <span className="sr-only">MFA column details</span>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        Green lock means MFA is enabled. Red lock means it is not enabled.
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </TableHead>
                {showProjectCounts && <TableHead className="text-center">Projects</TableHead>}
                <TableHead className="text-center">Last active</TableHead>
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
                <TableCell className="text-center">
                  <div className="flex justify-center">
                    <MemberRoleBadge role={member.role} label={member.role_label} />
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <div className="flex justify-center">
                    <Badge variant="outline" className={statusColors[member.status] || ""}>
                      {statusLabels[member.status] || member.status}
                    </Badge>
                  </div>
                </TableCell>
                <TableCell className="text-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center justify-center">
                        <Lock className={member.mfa_enabled ? "h-4 w-4 text-emerald-600" : "h-4 w-4 text-red-500"} />
                        <span className="sr-only">{member.mfa_enabled ? "MFA enabled" : "MFA disabled"}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {member.mfa_enabled ? "MFA is enabled for this user." : "MFA is not enabled for this user."}
                    </TooltipContent>
                  </Tooltip>
                </TableCell>
                {showProjectCounts && (
                  <TableCell className="text-center text-muted-foreground">
                    {member.project_count ?? 0}
                  </TableCell>
                )}
                <TableCell className="text-center text-sm text-muted-foreground">
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
                          roleOptions={roleOptions}
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
                        <DropdownMenuItem
                          disabled={isPending || !canManageMembers || member.status === "invited"}
                          onClick={() => resetMfa(member.id)}
                        >
                          Reset MFA
                        </DropdownMenuItem>
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
        </TooltipProvider>
      </div>
    </div>
  )
}
