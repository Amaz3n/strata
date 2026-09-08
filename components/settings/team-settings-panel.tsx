"use client"

import { useEffect, useRef, useState } from "react"
import { TeamRoster } from "@/components/team/team-roster"
import { Button } from "@/components/ui/button"
import { getTeamSettingsDataAction } from "@/app/(app)/settings/actions"

type TeamData = Awaited<ReturnType<typeof getTeamSettingsDataAction>>

export function TeamSettingsPanel({
  initialData,
  canManageBilling,
  onGoToBilling,
}: {
  initialData: TeamData
  canManageBilling: boolean
  onGoToBilling: () => void
}) {
  const [data, setData] = useState(initialData)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const lastInitialData = useRef(initialData)
  useEffect(() => {
    if (lastInitialData.current === initialData) return
    lastInitialData.current = initialData
    setData(initialData)
  }, [initialData])
  async function load(append = false) {
    if (inFlight.current) return
    inFlight.current = true
    setLoading(true)
    setError(null)
    try {
      const result = await getTeamSettingsDataAction({
        offset: append ? data.teamMembers.length : 0,
      })
      setData((previous) => ({
        ...result,
        teamMembers: append
          ? Array.from(
              new Map(
                [...previous.teamMembers, ...result.teamMembers].map((member) => [
                  member.id,
                  member,
                ]),
              ).values(),
            )
          : result.teamMembers,
      }))
    } catch {
      setError("Unable to load team members. Please try again.")
    } finally {
      inFlight.current = false
      setLoading(false)
    }
  }
  return (
    <>
      <TeamRoster
        members={data.teamMembers}
        onMembersChange={(updateMembers) =>
          setData((previous) => ({ ...previous, teamMembers: updateMembers(previous.teamMembers) }))
        }
        roleOptions={data.roleOptions}
        permissionOptions={data.permissionOptions}
        rolePermissions={data.rolePermissions}
        divisions={data.divisions}
        currentUserId={data.currentUserId}
        canManageMembers={data.canManageMembers}
        canEditRoles={data.canEditRoles}
        canManageBilling={canManageBilling}
        locked={data.locked}
        loading={loading}
        error={error}
        onReload={() => void load()}
        onGoToBilling={onGoToBilling}
      />
      {data.hasMore && (
        <div className="flex shrink-0 items-center justify-between gap-4 border-t px-6 py-3">
          <p className="text-xs text-muted-foreground">
            Showing {data.teamMembers.length} members. Search, filters and export cover loaded
            members.
          </p>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(true)}>
            Load more
          </Button>
        </div>
      )}
    </>
  )
}
