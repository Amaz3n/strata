"use client"

import { useEffect, useState, useTransition, type ReactNode } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { inviteTeamMemberAction } from "@/app/(app)/team/actions"
import { useToast } from "@/hooks/use-toast"
import type { OrgRole, OrgRoleOption } from "@/lib/types"
import { UserPlus } from "@/components/icons"

interface InviteMemberDialogProps {
  canInvite?: boolean
  roleOptions?: OrgRoleOption[]
  onSuccess?: () => void
  trigger?: ReactNode
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

export function InviteMemberDialog({ canInvite = false, roleOptions = [], onSuccess, trigger }: InviteMemberDialogProps) {
  const normalizedRoleOptions = roleOptions.length
    ? roleOptions
    : [
        { key: "org_owner", label: "Owner" },
        { key: "org_office_admin", label: "Office Admin" },
        { key: "org_project_lead", label: "Project Lead" },
        { key: "org_viewer", label: "Viewer" },
      ]
  const defaultRole =
    normalizedRoleOptions.find((option) => option.key === "org_project_lead")?.key ??
    normalizedRoleOptions[0]?.key ??
    "org_project_lead"
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<OrgRole>(defaultRole)
  const selectedRole = normalizedRoleOptions.find((option) => option.key === role)
  const selectedRoleDescription = selectedRole?.description ?? defaultRoleDescription(role)
  const selectedRoleHighlights = roleCapabilityHighlights(role)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()

  useEffect(() => {
    if (!open) {
      setRole(defaultRole)
    }
  }, [defaultRole, open])

  const submit = () => {
    if (!canInvite) {
      toast({ title: "Permission required", description: "You need member management access to invite teammates." })
      return
    }

    startTransition(async () => {
      try {
        const result = await inviteTeamMemberAction({ email, role })
        if (result?.tempPassword) {
          toast({
            title: "Invite created (dev)",
            description: `Temp password: ${result.tempPassword}`,
          })
        } else {
          toast({ title: "Invite sent" })
        }
        setOpen(false)
        setEmail("")
        setRole(defaultRole)
        if (onSuccess) {
          onSuccess()
        } else {
          router.refresh()
        }
      } catch (error) {
        toast({ title: "Invite failed", description: (error as Error).message })
      }
    })
  }

  const triggerNode = trigger ?? (
    <Button disabled={!canInvite}>
      <UserPlus className="h-4 w-4 mr-2" />
      Invite member
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {triggerNode}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite team member</DialogTitle>
          <DialogDescription>Send an invite email and set their role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" placeholder="person@company.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <Select value={role} onValueChange={(value) => setRole(value as OrgRole)}>
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
            <Button onClick={submit} disabled={isPending || !email}>
              {isPending ? "Sending..." : "Send invite"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
