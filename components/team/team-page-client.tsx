"use client"

import { useState } from "react"

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { TeamTable } from "@/components/team/team-table"
import { MemberFormPanel } from "@/components/team/member-form-panel"
import { Button } from "@/components/ui/button"
import { UserPlus } from "@/components/icons"
import type { OrgRoleOption, PermissionOption, TeamMember } from "@/lib/types"

interface TeamPageClientProps {
  members: TeamMember[]
  canManageMembers: boolean
  canEditRoles: boolean
  roleOptions: OrgRoleOption[]
  permissionOptions: PermissionOption[]
}

type FormView = { mode: "invite" } | { mode: "edit"; member: TeamMember } | null

export function TeamPageClient({
  members,
  canManageMembers,
  canEditRoles,
  roleOptions,
  permissionOptions,
}: TeamPageClientProps) {
  const [view, setView] = useState<FormView>(null)

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Team</h1>
          <p className="text-muted-foreground mt-1">Manage internal teammates, roles, and invite workflow.</p>
        </div>
        <Button disabled={!canManageMembers} onClick={() => setView({ mode: "invite" })}>
          <UserPlus className="h-4 w-4 mr-2" />
          Invite member
        </Button>
      </div>

      <TeamTable
        members={members}
        canManageMembers={canManageMembers}
        canEditRoles={canEditRoles}
        onInviteMember={() => setView({ mode: "invite" })}
        onEditMember={(member) => setView({ mode: "edit", member })}
      />

      <Sheet open={view !== null} onOpenChange={(next) => !next && setView(null)}>
        <SheetContent
          side="right"
          className="w-full p-0 sm:max-w-2xl"
        >
          <SheetTitle className="sr-only">
            {view?.mode === "edit" ? "Edit team member" : "Invite team member"}
          </SheetTitle>
          {view ? (
            <MemberFormPanel
              mode={view.mode}
              member={view.mode === "edit" ? view.member : undefined}
              roleOptions={roleOptions}
              permissionOptions={permissionOptions}
              canManageMembers={canManageMembers}
              canEditRoles={canEditRoles}
              onCancel={() => setView(null)}
              onSuccess={() => setView(null)}
            />
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  )
}
