"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"
import { X } from "lucide-react"

import type { Contact, TeamMember } from "@/lib/types"
import type { DistributionMember, DistributionScope } from "@/lib/services/distribution-lists"
import { unwrapAction } from "@/lib/action-result"
import {
  addDistributionMemberAction,
  listDistributionMembersAction,
  removeDistributionMemberAction,
} from "@/app/(app)/projects/[id]/actions"
import { listTeamMembersAction } from "@/app/(app)/team/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const scopeLabels: Record<DistributionScope, string> = {
  rfis: "RFIs",
  submittals: "Submittals",
  all: "RFIs + Submittals",
}

interface DistributionListManagerProps {
  projectId: string
  contacts: Contact[]
}

interface TeamOption {
  userId: string
  name: string
  email?: string | null
}

/**
 * Managed per-project distribution list: everyone here is copied on RFI and
 * submittal emails for their scope (and feeds transmittal recipients later).
 */
export function DistributionListManager({ projectId, contacts }: DistributionListManagerProps) {
  const [members, setMembers] = useState<DistributionMember[] | null>(null)
  const [team, setTeam] = useState<TeamOption[]>([])
  const [selection, setSelection] = useState("")
  const [scope, setScope] = useState<DistributionScope>("all")
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    listDistributionMembersAction(projectId)
      .then(setMembers)
      .catch((error) => {
        console.error("Failed to load distribution list", error)
        setMembers([])
      })
    listTeamMembersAction()
      .then((rows: TeamMember[]) =>
        setTeam(
          rows
            .filter((row) => row.status === "active" && row.user?.id)
            .map((row) => ({
              userId: row.user.id,
              name: row.user.full_name ?? row.user.email ?? "Team member",
              email: row.user.email,
            })),
        ),
      )
      .catch(() => setTeam([]))
  }, [projectId])

  const contactOptions = contacts.filter((contact) => !!contact.email)

  const handleAdd = () => {
    if (!selection) return
    const [kind, id] = selection.split(":")
    startTransition(async () => {
      try {
        const member = unwrapAction(
          await addDistributionMemberAction({
            project_id: projectId,
            scope,
            contact_id: kind === "contact" ? id : null,
            user_id: kind === "user" ? id : null,
          }),
        )
        setMembers((prev) => [...(prev ?? []), member])
        setSelection("")
      } catch (error) {
        toast.error("Failed to add to distribution list", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  const handleRemove = (memberId: string) => {
    startTransition(async () => {
      try {
        unwrapAction(await removeDistributionMemberAction(memberId))
        setMembers((prev) => (prev ?? []).filter((member) => member.id !== memberId))
      } catch (error) {
        toast.error("Failed to remove member", {
          description: error instanceof Error ? error.message : "Please try again.",
        })
      }
    })
  }

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-sm font-medium">Distribution lists</Label>
        <p className="text-xs text-muted-foreground">
          Copied on RFI and submittal emails for this project.
        </p>
      </div>

      {members === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : members.length === 0 ? (
        <p className="text-xs text-muted-foreground">No one is on the distribution list yet.</p>
      ) : (
        <ul className="space-y-1">
          {members.map((member) => (
            <li key={member.id} className="flex items-center justify-between gap-2 border px-3 py-2 text-sm">
              <span className="min-w-0 truncate">
                {member.name ?? member.email}
                {member.company_name ? (
                  <span className="text-xs text-muted-foreground"> — {member.company_name}</span>
                ) : member.user_id ? (
                  <span className="text-xs text-muted-foreground"> — Team</span>
                ) : null}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge variant="outline" className="text-[10px]">
                  {scopeLabels[member.scope]}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handleRemove(member.id)}
                  disabled={isPending}
                  aria-label="Remove from distribution list"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={selection} onValueChange={setSelection}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Add contact or team member" />
          </SelectTrigger>
          <SelectContent>
            {contactOptions.map((contact) => (
              <SelectItem key={`contact:${contact.id}`} value={`contact:${contact.id}`}>
                <span className="block">{contact.full_name}</span>
                <span className="block text-[10px] text-muted-foreground">{contact.email}</span>
              </SelectItem>
            ))}
            {team.map((member) => (
              <SelectItem key={`user:${member.userId}`} value={`user:${member.userId}`}>
                <span className="block">{member.name}</span>
                <span className="block text-[10px] text-muted-foreground">Team{member.email ? ` · ${member.email}` : ""}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scope} onValueChange={(value) => setScope(value as DistributionScope)}>
          <SelectTrigger className="sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.entries(scopeLabels) as Array<[DistributionScope, string]>).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={isPending || !selection}>
          Add
        </Button>
      </div>
    </div>
  )
}
