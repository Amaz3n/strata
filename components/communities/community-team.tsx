"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { assignCommunityMemberAction, removeCommunityAssignmentAction } from "@/app/(app)/communities/actions"
import { Plus, Users } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import {
  COMMUNITY_ASSIGNMENT_ROLE_LABELS,
  type CommunityAssignmentDTO,
} from "@/lib/services/community-assignments"
import type { CommunityAssignmentRole } from "@/lib/validation/communities"

const ROLES = Object.keys(COMMUNITY_ASSIGNMENT_ROLE_LABELS) as CommunityAssignmentRole[]

/**
 * Who works this community. Assignments default the ambient community lens, so
 * a consultant who sits one model home opens Arc already scoped to it.
 */
export function CommunityTeam({
  communityId,
  assignments,
  members,
  canWrite,
}: {
  communityId: string
  assignments: CommunityAssignmentDTO[]
  members: Array<{ id: string; name: string }>
  canWrite: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [userId, setUserId] = useState("")
  const [role, setRole] = useState<CommunityAssignmentRole>("sales")

  function assign() {
    if (!userId) return
    startTransition(async () => {
      try {
        unwrapAction(await assignCommunityMemberAction({ communityId, userId, role }))
        toast.success("Assignment added")
        setOpen(false)
        setUserId("")
        router.refresh()
      } catch (error) {
        toast.error("Unable to assign", { description: (error as Error).message })
      }
    })
  }

  function remove(assignment: CommunityAssignmentDTO) {
    startTransition(async () => {
      try {
        unwrapAction(await removeCommunityAssignmentAction(assignment.id))
        toast.success(`${assignment.name} removed`)
        router.refresh()
      } catch (error) {
        toast.error("Unable to remove assignment", { description: (error as Error).message })
      }
    })
  }

  return (
    <div className="max-w-3xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Community team</h2>
          <p className="text-xs text-muted-foreground">
            Assigned staff open Arc scoped to this community. Assignment is a convenience scope, not a permission —
            access is still governed by roles and divisions.
          </p>
        </div>
        {canWrite ? (
          <Button size="sm" className="rounded-none" onClick={() => setOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" />
            Assign someone
          </Button>
        ) : null}
      </div>

      {assignments.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 border border-dashed px-6 py-14 text-center">
          <Users className="h-5 w-5 text-muted-foreground" />
          <p className="text-sm font-medium">Nobody assigned yet</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Assign the sales consultant and superintendent who work this community so their desks default to it.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow className="text-[11px] uppercase tracking-wide">
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Email</TableHead>
                {canWrite ? <TableHead className="w-20" /> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {assignments.map((assignment) => (
                <TableRow key={assignment.id} className="text-xs">
                  <TableCell className="font-medium">{assignment.name}</TableCell>
                  <TableCell>{COMMUNITY_ASSIGNMENT_ROLE_LABELS[assignment.role]}</TableCell>
                  <TableCell className="text-muted-foreground">{assignment.email ?? "—"}</TableCell>
                  {canWrite ? (
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 rounded-none px-2 text-[11px]"
                        disabled={isPending}
                        onClick={() => remove(assignment)}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Assign to this community</DialogTitle>
            <DialogDescription>Their desks will default to this community when it is their only assignment.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label>Person</Label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger><SelectValue placeholder="Select a team member" /></SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      {member.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(value) => setRole(value as CommunityAssignmentRole)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {COMMUNITY_ASSIGNMENT_ROLE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={!userId || isPending} onClick={assign}>
              {isPending ? "Assigning…" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
