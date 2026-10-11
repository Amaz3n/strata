"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import {
  getOrgSecurityPolicyAction,
  listOrgSupportAccessAction,
  revokePlatformAccessGrantAction,
  setOrgRequireMfaAction,
} from "@/app/(app)/settings/actions"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsError, SettingsGroup, SettingsToggle } from "@/components/settings/settings-section"
import { unwrapAction } from "@/lib/action-result"
import type { OrgSupportAccessHistory, PlatformAccessGrant } from "@/lib/services/platform-session"
import { cn } from "@/lib/utils"

/**
 * Organization-wide security policy. Only administrators see it; the toggle is
 * the one place the requirement is set, and enforcement happens at sign-in and
 * on every request, not here.
 */
export function OrgSecurityGroup() {
  const [requireMfa, setRequireMfa] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    let active = true
    getOrgSecurityPolicyAction()
      .then((result) => {
        if (active) setRequireMfa(unwrapAction(result).requireMfa)
      })
      .catch((loadError: unknown) => {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : "Unable to load security settings")
      })
    return () => {
      active = false
    }
  }, [])

  const update = (next: boolean) => {
    setError(null)
    startTransition(async () => {
      try {
        const saved = unwrapAction(await setOrgRequireMfaAction({ requireMfa: next }))
        setRequireMfa(saved.requireMfa)
        toast.success(saved.requireMfa ? "Two-factor is now required" : "Two-factor is no longer required")
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Unable to save security settings")
      }
    })
  }

  return (
    <>
      <SettingsGroup title="Security">
        {error ? <SettingsError>{error}</SettingsError> : null}
        {requireMfa === null && !error ? (
          <div className="py-4">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : null}
        {requireMfa !== null ? (
          <SettingsToggle
            id="org-require-mfa"
            label="Require two-factor authentication"
            description="Members without two-factor are asked to set it up before they can use Arc. Applies to the web app and, once their session is verified, the mobile app. Open sessions pick it up within ten minutes."
            checked={requireMfa}
            onCheckedChange={update}
            disabled={isPending}
          />
        ) : null}
      </SettingsGroup>
      <SupportAccessGroup />
    </>
  )
}

function formatWhen(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function grantStatus(grant: PlatformAccessGrant, now: number) {
  if (grant.endedAt) return { label: `Ended ${formatWhen(grant.endedAt)}`, active: false }
  if (new Date(grant.expiresAt).getTime() <= now) return { label: `Expired ${formatWhen(grant.expiresAt)}`, active: false }
  return { label: `Active until ${formatWhen(grant.expiresAt)}`, active: true }
}

/**
 * Every time Arc support entered this organization in the last 90 days: who,
 * why, and for how long. Administrators can end access that is still open.
 */
function SupportAccessGroup() {
  const [history, setHistory] = useState<OrgSupportAccessHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let active = true
    listOrgSupportAccessAction()
      .then((result) => {
        if (!active) return
        setHistory(unwrapAction(result))
        setNow(Date.now())
      })
      .catch((loadError: unknown) => {
        if (!active) return
        setError(loadError instanceof Error ? loadError.message : "Unable to load support access")
      })
    return () => {
      active = false
    }
  }, [])

  const revoke = async (grantId: string) => {
    setError(null)
    setRevokingId(grantId)
    try {
      const ended = unwrapAction(await revokePlatformAccessGrantAction({ grantId }))
      setHistory((current) =>
        current
          ? { ...current, grants: current.grants.map((grant) => (grant.id === ended.id ? ended : grant)) }
          : current,
      )
      toast.success("Arc support access ended")
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "Unable to end support access")
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <SettingsGroup
      title="Arc support access"
      description="Arc staff can enter this organization only with a stated reason, for at most eight hours. Every entry from the last 90 days is listed here."
    >
      {error ? <SettingsError className="py-3">{error}</SettingsError> : null}
      {history === null && !error ? (
        <div className="space-y-2 py-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
      {history && history.grants.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">Arc support has not accessed this organization.</p>
      ) : null}
      {history?.grants.map((grant) => {
        const status = grantStatus(grant, now)
        return (
          <div key={grant.id} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium leading-5 text-foreground">{grant.operatorEmail}</p>
              <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{grant.reason}</p>
              <p className="mt-0.5 text-xs leading-5 tabular-nums text-muted-foreground">
                Started {formatWhen(grant.grantedAt)} ·{" "}
                <span className={cn(status.active && "font-medium text-warning")}>{status.label}</span>
              </p>
            </div>
            {status.active ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={revokingId !== null}
                onClick={() => revoke(grant.id)}
              >
                {revokingId === grant.id ? "Ending..." : "End access"}
              </Button>
            ) : null}
          </div>
        )
      })}
      {history?.truncated ? (
        <p className="py-3 text-xs text-muted-foreground">Showing the 50 most recent entries.</p>
      ) : null}
    </SettingsGroup>
  )
}
