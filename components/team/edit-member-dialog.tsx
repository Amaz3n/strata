"use client"

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { OrgRole, TeamMember } from "@/lib/types"
import { updateMemberProfileAction, updateMemberRoleAction } from "@/app/(app)/team/actions"
import { useToast } from "@/hooks/use-toast"
import { Edit } from "@/components/icons"

interface EditMemberDialogProps {
  member: TeamMember
  canManageMembers?: boolean
  canEditRoles?: boolean
  trigger?: ReactNode
  onSuccess?: () => void
}

export function EditMemberDialog({
  member,
  canManageMembers = false,
  canEditRoles = false,
  trigger,
  onSuccess,
}: EditMemberDialogProps) {
  const [open, setOpen] = useState(false)
  const [fullName, setFullName] = useState(member.user.full_name ?? "")
  const [role, setRole] = useState<OrgRole>(member.role)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  useEffect(() => {
    if (open) {
      setFullName(member.user.full_name ?? "")
      setRole(member.role)
    }
  }, [open, member.role, member.user.full_name])

  const canEditProfile = canManageMembers
  const hasRoleChange = role !== member.role
  const normalizedName = fullName.trim()
  const hasNameChange = normalizedName !== (member.user.full_name ?? "")

  const hasChanges = useMemo(() => {
    if (canEditProfile && hasNameChange) return true
    if (canEditRoles && hasRoleChange) return true
    return false
  }, [canEditProfile, canEditRoles, hasNameChange, hasRoleChange])

  const submit = () => {
    if (!hasChanges) {
      setOpen(false)
      return
    }

    startTransition(async () => {
      try {
        if (canEditProfile && hasNameChange) {
          await updateMemberProfileAction(member.user.id, { full_name: normalizedName })
        }

        if (canEditRoles && hasRoleChange) {
          await updateMemberRoleAction(member.id, { role })
        }

        toast({ title: "Member updated" })
        setOpen(false)
        if (onSuccess) {
          onSuccess()
        } else {
          router.refresh()
        }
      } catch (error) {
        toast({ title: "Unable to update member", description: (error as Error).message })
      }
    })
  }

  const canEditAnything = canEditProfile || canEditRoles

  const triggerNode = trigger ?? (
    <Button variant="ghost" size="icon" disabled={!canEditAnything} className="h-8 w-8">
      <Edit className="h-4 w-4" />
      <span className="sr-only">Edit member</span>
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{triggerNode}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit team member</DialogTitle>
          <DialogDescription>Update profile details and access level.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              disabled={!canEditProfile}
              placeholder="Full name"
            />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input value={member.user.email ?? ""} disabled />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as OrgRole)} disabled={!canEditRoles}>
              <SelectTrigger>
                <SelectValue placeholder="Select role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">Owner</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="staff">Staff</SelectItem>
                <SelectItem value="readonly">Read-only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={isPending || !hasChanges || (canEditProfile && !normalizedName)}>
              {isPending ? "Saving..." : "Save changes"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
