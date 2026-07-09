"use client"

import { useState, useEffect } from "react"
import { clearOrgContextAction, endImpersonationAction } from "@/app/(app)/platform/actions"
import { AlertTriangle } from "@/components/icons"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { PlatformAccessState } from "@/lib/services/platform-access"
import type { PlatformSessionState } from "@/lib/services/platform-session"
import { unwrapAction } from "@/lib/action-result"

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "-"
  return d.toLocaleString()
}

export function PlatformSessionControl({
  access,
  state,
}: {
  access: PlatformAccessState
  state: PlatformSessionState
}) {
  async function endImpersonation() {
    unwrapAction(await endImpersonationAction())
  }

  async function clearOrgContext() {
    unwrapAction(await clearOrgContextAction())
  }

  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  if (!mounted) return null
  if (!access.canAccessPlatform) return null

  const showContext = state.platformContext.active
  const showImpersonation = state.impersonation.active

  if (!showContext && !showImpersonation) {
    return null
  }

  const label = showImpersonation ? "Impersonating" : "Org context"
  const impersonationTarget =
    state.impersonation.targetName ?? state.impersonation.targetEmail ?? state.impersonation.targetUserId

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge
          asChild
          variant="outline"
          className="h-8 cursor-default border-amber-500/40 bg-amber-500/10 px-2.5 text-amber-700 hover:bg-amber-500/15 dark:text-amber-200"
        >
          <button type="button" aria-label="View elevated platform session details">
            <AlertTriangle className="size-3.5" />
            <span className="hidden sm:inline">{label}</span>
          </button>
        </Badge>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="size-4 text-amber-500" />
            Platform elevated session
          </div>
          <p className="text-xs text-muted-foreground">
            Support access is active. Actions are audited and scoped to this session.
          </p>
        </div>

        <div className="space-y-3 text-sm">
          {showImpersonation ? (
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Impersonating</p>
              <p className="font-medium">{impersonationTarget}</p>
              <p className="text-xs text-muted-foreground">Expires {formatDateTime(state.impersonation.expiresAt)}</p>
            </div>
          ) : null}
          {showContext ? (
            <div className="space-y-1">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Org context</p>
              <p className="font-medium">{state.platformContext.orgName ?? state.platformContext.orgId}</p>
              <p className="text-xs text-muted-foreground">Started {formatDateTime(state.platformContext.startedAt)}</p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {showImpersonation ? (
            <form action={endImpersonation}>
              <Button size="sm" variant="destructive" type="submit">
                End impersonation
              </Button>
            </form>
          ) : null}
          {showContext ? (
            <form action={clearOrgContext}>
              <Button size="sm" variant="outline" type="submit">
                Exit org context
              </Button>
            </form>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
