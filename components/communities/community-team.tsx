"use client"

import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { assignCommunityMemberAction, removeCommunityAssignmentAction } from "@/app/(app)/communities/actions"
import { Plus } from "@/components/icons"
import { SettingsGroup } from "@/components/settings/settings-section"
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
import { unwrapAction } from "@/lib/action-result"
import type { CommunityAssignmentDTO } from "@/lib/services/community-assignments"
import {
  COMMUNITY_ASSIGNMENT_ROLE_LABELS,
  type CommunityAssignmentRole,
} from "@/lib/validation/communities"

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
    <>
      {/* A roster group, not a table in a panel — the shape every other roster in
          Settings uses. */}
      <SettingsGroup
        title="Community team"
        description="Assigned staff open Arc scoped to this community. Assignment is a convenience scope, not a permission — access is still governed by roles and divisions."
        action={
          canWrite ? (
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              Assign
            </Button>
          ) : null
        }
      >
        {assignments.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            Nobody is assigned. Assign the sales consultant and superintendent who work this community so their desks
            default to it.
          </p>
        ) : (
          assignments.map((assignment) => (
            <div key={assignment.id} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{assignment.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {COMMUNITY_ASSIGNMENT_ROLE_LABELS[assignment.role]}
                  {assignment.email ? ` · ${assignment.email}` : ""}
                </p>
              </div>
              {canWrite ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={isPending}
                  onClick={() => remove(assignment)}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))
        )}
      </SettingsGroup>

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
    </>
  )
}
