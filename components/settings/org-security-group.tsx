"use client"

import { useEffect, useState, useTransition } from "react"
import { toast } from "sonner"

import { getOrgSecurityPolicyAction, setOrgRequireMfaAction } from "@/app/(app)/settings/actions"
import { Skeleton } from "@/components/ui/skeleton"
import { SettingsError, SettingsGroup, SettingsToggle } from "@/components/settings/settings-section"
import { unwrapAction } from "@/lib/action-result"

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
  )
}
