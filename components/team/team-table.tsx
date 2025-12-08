"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { TeamMember, OrgRole } from "@/lib/types"
import { MemberRoleBadge } from "@/components/team/member-role-badge"
import {
  reactivateMemberAction,
  removeMemberAction,
  resendInviteAction,
  suspendMemberAction,
  updateMemberRoleAction,
} from "@/app/team/actions"
import { MoreHorizontal } from "@/components/icons"
import { useToast } from "@/hooks/use-toast"

interface TeamTableProps {
  members: TeamMember[]
  canManageMembers?: boolean
  canEditRoles?: boolean
}

export function TeamTable({ members, canManageMembers = false, canEditRoles = false }: TeamTableProps) {
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  const updateRole = (membershipId: string, role: OrgRole) => {
    if (!canEditRoles) {
      toast({ title: "Permission required", description: "Only admins can change member roles." })
      return
    }

    startTransition(async () => {
      try {
        await updateMemberRoleAction(membershipId, { role })
        toast({ title: "Role updated" })
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to update role", description: (error as Error).message })
      }
    })
  }

  const suspend = (membershipId: string) => {
    if (!canManageMembers) {
      toast({ title: "Permission required", description: "You need member management access to suspend users." })
      return
    }

    startTransition(async () => {
      try {
        await suspendMemberAction(membershipId)
        toast({ title: "Member suspended" })
        router.refresh()
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
        toast({ title: "Member reactivated" })
        router.refresh()
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
        router.refresh()
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
        router.refresh()
      } catch (error) {
        toast({ title: "Unable to resend invite", description: (error as Error).message })
      }
    })
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Team</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Projects</TableHead>
              <TableHead>Last active</TableHead>
              {(canManageMembers || canEditRoles) && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell className="font-medium">
                  <div className="flex flex-col">
                    <span>{member.user.full_name}</span>
                    <span className="text-xs text-muted-foreground">{member.user.email}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <MemberRoleBadge role={member.role} />
                </TableCell>
                <TableCell>
                  <Badge variant={member.status === "active" ? "secondary" : "outline"} className="uppercase">
                    {member.status}
                  </Badge>
                </TableCell>
                <TableCell>{member.project_count ?? 0}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {member.last_active_at ? new Date(member.last_active_at).toLocaleDateString() : "—"}
                </TableCell>
                {(canManageMembers || canEditRoles) && (
                  <TableCell className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem disabled={!canEditRoles} onClick={() => updateRole(member.id, "admin")}>
                          Make admin
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEditRoles} onClick={() => updateRole(member.id, "staff")}>
                          Set as staff
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={!canEditRoles} onClick={() => updateRole(member.id, "readonly")}>
                          Set read-only
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {member.status === "suspended" ? (
                          <DropdownMenuItem disabled={isPending || !canManageMembers} onClick={() => reactivate(member.id)}>
                            Reactivate
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem disabled={isPending || !canManageMembers} onClick={() => suspend(member.id)}>
                            Suspend
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem disabled={isPending || !canManageMembers} onClick={() => resend(member.id)}>
                          Resend invite
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
            {members.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                  No team members found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

