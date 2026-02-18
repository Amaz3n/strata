"use client"

import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { OrgRole, OrgRoleOption, TeamMember } from "@/lib/types"
import { updateMemberProfileAction, updateMemberRoleAction } from "@/app/(app)/team/actions"
import { useToast } from "@/hooks/use-toast"
import { Edit } from "@/components/icons"

interface EditMemberDialogProps {
  member: TeamMember
  canManageMembers?: boolean
  canEditRoles?: boolean
  roleOptions?: OrgRoleOption[]
  trigger?: ReactNode
  onSuccess?: () => void
}

function toRoleLabel(roleKey: string) {
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function normalizeRoleLabel(label: string | undefined, roleKey: string) {
  const candidate = (label ?? "").replace(/^org[\s_-]+/i, "").trim()
  return candidate || toRoleLabel(roleKey)
}

function defaultRoleDescription(roleKey: string) {
  const descriptions: Record<string, string> = {
    org_owner: "Full account control, including organization settings, billing, and team role management.",
    org_office_admin: "Administrative control across projects and teams, including member management and business operations.",
    org_project_lead: "Execution-focused access for project delivery, field workflows, and day-to-day coordination.",
    org_viewer: "View-only access across shared data with no write or approval permissions.",
  }
  return descriptions[roleKey]
}

function roleCapabilityHighlights(roleKey: string) {
  const capabilities: Record<string, string[]> = {
    org_owner: [
      "Manage billing, plans, and organization settings",
      "Invite/remove members and assign any role",
      "Approve financial workflows and high-impact changes",
    ],
    org_office_admin: [
      "Manage team access and most workspace settings",
      "Run project operations and approvals",
      "Handle day-to-day admin tasks across the org",
    ],
    org_project_lead: [
      "Own schedules, docs, RFIs, submittals, and field workflows",
      "Coordinate project execution and operational approvals",
      "Manage team collaboration on active jobs",
    ],
    org_viewer: [
      "View projects, docs, and reports",
      "No edits, approvals, or member management",
      "Good for stakeholders who only need visibility",
    ],
  }

  return capabilities[roleKey] ?? []
}

export function EditMemberDialog({
  member,
  canManageMembers = false,
  canEditRoles = false,
  roleOptions = [],
  trigger,
  onSuccess,
}: EditMemberDialogProps) {
  const [open, setOpen] = useState(false)
  const [fullName, setFullName] = useState(member.user.full_name ?? "")
  const [role, setRole] = useState<OrgRole>(member.role)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const baseRoleOptions = roleOptions.length
    ? roleOptions
    : [
        { key: "org_owner", label: "Owner" },
        { key: "org_office_admin", label: "Office Admin" },
        { key: "org_project_lead", label: "Project Lead" },
        { key: "org_viewer", label: "Viewer" },
      ]
  const normalizedRoleOptions = baseRoleOptions.some((option) => option.key === member.role)
    ? baseRoleOptions
    : [{ key: member.role, label: member.role_label ?? toRoleLabel(member.role) }, ...baseRoleOptions]
  const selectedRole = normalizedRoleOptions.find((option) => option.key === role)
  const selectedRoleDescription = selectedRole?.description ?? defaultRoleDescription(role)
  const selectedRoleHighlights = roleCapabilityHighlights(role)

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
                {normalizedRoleOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {normalizeRoleLabel(option.label, option.key)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRoleDescription ? (
              <div className="rounded-md border bg-muted/40 p-3 text-xs">
                <p className="font-medium text-foreground">{normalizeRoleLabel(selectedRole?.label, role)}</p>
                <p className="mt-1 text-muted-foreground">{selectedRoleDescription}</p>
                {selectedRoleHighlights.length > 0 ? (
                  <ul className="mt-2 space-y-1 text-muted-foreground">
                    {selectedRoleHighlights.map((item) => (
                      <li key={item}>• {item}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}
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
