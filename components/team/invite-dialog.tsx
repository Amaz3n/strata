"use client"

import { useMemo, useState, useTransition } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { X } from "@/components/icons"
import { cn } from "@/lib/utils"
import { toast } from "sonner"
import { unwrapAction } from "@/lib/action-result"
import { inviteTeamMemberAction } from "@/app/(app)/team/actions"
import type { DivisionDTO } from "@/lib/services/divisions"
import type { OrgRole, OrgRoleOption, TeamMember } from "@/lib/types"
import { isAdminRole, type RolePermissionMap } from "@/components/team/roster-utils"

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface ParsedEmail {
  value: string
  status: "ok" | "invalid" | "existing"
}

function parseEmails(raw: string, existing: Set<string>): ParsedEmail[] {
  const seen = new Set<string>()
  const out: ParsedEmail[] = []
  for (const token of raw.split(/[\s,;]+/)) {
    const value = token.trim().toLowerCase()
    if (!value || seen.has(value)) continue
    seen.add(value)
    if (!EMAIL_RE.test(value)) out.push({ value, status: "invalid" })
    else if (existing.has(value)) out.push({ value, status: "existing" })
    else out.push({ value, status: "ok" })
  }
  return out
}

interface InviteDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  roleOptions: OrgRoleOption[]
  rolePermissions: RolePermissionMap
  divisions: DivisionDTO[]
  existingEmails: Set<string>
  onInvited: () => void
}

export function InviteDialog({
  open,
  onOpenChange,
  roleOptions,
  rolePermissions,
  divisions,
  existingEmails,
  onInvited,
}: InviteDialogProps) {
  const [isPending, startTransition] = useTransition()
  const defaultRole = useMemo(() => {
    const scoped = roleOptions.find((option) => !isAdminRole(option.key, rolePermissions))
    return (scoped ?? roleOptions[0])?.key ?? "org_user"
  }, [roleOptions, rolePermissions])

  const [raw, setRaw] = useState("")
  const [role, setRole] = useState<OrgRole>(defaultRole as OrgRole)
  const [projectScope, setProjectScope] = useState<"all" | "assigned">("all")
  const [divisionScope, setDivisionScope] = useState<"all" | "assigned">("all")
  const [divisionIds, setDivisionIds] = useState<string[]>([])

  const parsed = useMemo(() => parseEmails(raw, existingEmails), [raw, existingEmails])
  const sendable = parsed.filter((entry) => entry.status === "ok")
  const roleIsAdmin = isAdminRole(role, rolePermissions)
  const scopeApplies = !roleIsAdmin

  const reset = () => {
    setRaw("")
    setRole(defaultRole as OrgRole)
    setProjectScope("all")
    setDivisionScope("all")
    setDivisionIds([])
  }

  const close = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const removeEmail = (value: string) => {
    setRaw((current) =>
      current
        .split(/[\s,;]+/)
        .filter((token) => token.trim().toLowerCase() !== value)
        .join(" "),
    )
  }

  const send = () => {
    if (sendable.length === 0) return
    const effectiveScope: "all" | "assigned" = scopeApplies ? projectScope : "all"
    const effectiveDivisionScope: "all" | "assigned" = scopeApplies ? divisionScope : "all"

    startTransition(async () => {
      let sent = 0
      const failures: string[] = []
      for (const entry of sendable) {
        try {
          unwrapAction(
            await inviteTeamMemberAction({
              email: entry.value,
              role,
              projectScope: effectiveScope,
              divisionScope: effectiveDivisionScope,
              divisionIds: effectiveDivisionScope === "assigned" ? divisionIds : [],
              permissionOverrides: [],
            }),
          )
          sent += 1
        } catch (error) {
          failures.push(`${entry.value}: ${(error as Error).message}`)
        }
      }

      if (sent > 0) {
        toast.success(sent === 1 ? `Invite sent to ${sendable[0].value}` : `${sent} invites sent`)
      }
      if (failures.length > 0) {
        toast.error(`${failures.length} invite${failures.length === 1 ? "" : "s"} failed`, { description: failures[0] })
      }
      if (sent > 0) {
        onInvited()
        close(false)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-sm font-medium">Invite team members</DialogTitle>
          <DialogDescription className="text-xs">
            Paste one or more email addresses. Everyone gets the same role and access; fine-tune each person afterward.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-5 py-5">
          <section className="space-y-2">
            <p className="microlabel">Emails</p>
            <Textarea
              autoFocus
              value={raw}
              onChange={(event) => setRaw(event.target.value)}
              placeholder="sam@builder.com, dana@builder.com"
              className="min-h-[72px]"
            />
            {parsed.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {parsed.map((entry) => (
                  <span
                    key={entry.value}
                    className={cn(
                      "inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs",
                      entry.status === "ok" && "border-border text-foreground",
                      entry.status === "invalid" && "border-destructive/40 text-destructive",
                      entry.status === "existing" && "border-border text-muted-foreground",
                    )}
                  >
                    {entry.value}
                    {entry.status === "existing" ? <span className="text-[10px]">· already a member</span> : null}
                    {entry.status === "invalid" ? <span className="text-[10px]">· invalid</span> : null}
                    <button
                      type="button"
                      onClick={() => removeEmail(entry.value)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${entry.value}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <p className="microlabel">Role</p>
            <Select value={role} onValueChange={(value) => setRole(value as OrgRole)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {roleOptions.find((option) => option.key === role)?.description ??
                (roleIsAdmin ? "Full access to every project and setting." : "Scoped access — refine per person later.")}
            </p>
          </section>

          {scopeApplies ? (
            <section className="space-y-2">
              <p className="microlabel">Project access</p>
              <ToggleGroup
                type="single"
                value={projectScope}
                onValueChange={(value) => value && setProjectScope(value as "all" | "assigned")}
                variant="outline"
                className="justify-start"
              >
                <ToggleGroupItem value="all" className="px-3 text-xs">
                  All projects
                </ToggleGroupItem>
                <ToggleGroupItem value="assigned" className="px-3 text-xs">
                  Assigned only
                </ToggleGroupItem>
              </ToggleGroup>
            </section>
          ) : null}

          {scopeApplies && divisions.length > 0 ? (
            <section className="space-y-2">
              <p className="microlabel">Division access</p>
              <ToggleGroup
                type="single"
                value={divisionScope}
                onValueChange={(value) => value && setDivisionScope(value as "all" | "assigned")}
                variant="outline"
                className="justify-start"
              >
                <ToggleGroupItem value="all" className="px-3 text-xs">
                  All divisions
                </ToggleGroupItem>
                <ToggleGroupItem value="assigned" className="px-3 text-xs">
                  Selected
                </ToggleGroupItem>
              </ToggleGroup>
              {divisionScope === "assigned" ? (
                <div className="mt-1 divide-y divide-border border-t border-border">
                  {divisions
                    .filter((division) => !division.archived)
                    .map((division) => (
                      <label key={division.id} className="flex items-center gap-2 py-2 text-sm">
                        <Checkbox
                          checked={divisionIds.includes(division.id)}
                          onCheckedChange={(checked) =>
                            setDivisionIds((current) =>
                              checked ? Array.from(new Set([...current, division.id])) : current.filter((id) => id !== division.id),
                            )
                          }
                        />
                        <span>{division.name}</span>
                      </label>
                    ))}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>

        <DialogFooter className="border-t border-border px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => close(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={send} disabled={sendable.length === 0 || isPending}>
            {isPending
              ? "Sending…"
              : sendable.length > 1
                ? `Send ${sendable.length} invites`
                : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
