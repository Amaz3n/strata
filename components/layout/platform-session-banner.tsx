import { clearOrgContextAction, endImpersonationAction } from "@/app/(app)/platform/actions"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { AlertTriangle } from "@/components/icons"
import { getCurrentPlatformAccess } from "@/lib/services/platform-access"
import { getPlatformSessionState } from "@/lib/services/platform-session"

function formatDateTime(value?: string | null) {
  if (!value) return "-"
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return "-"
  return d.toLocaleString()
}

export async function PlatformSessionBanner() {
  const [access, state] = await Promise.all([getCurrentPlatformAccess(), getPlatformSessionState()])
  if (!access.canAccessPlatform) return null

  const showContext = state.platformContext.active
  const showImpersonation = state.impersonation.active

  if (!showContext && !showImpersonation) {
    return null
  }

  return (
    <div className="border-b border-border px-4 py-3">
      <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-100">
        <AlertTriangle className="text-amber-200" />
        <AlertTitle>Platform elevated session active</AlertTitle>
        <AlertDescription>
          <div className="space-y-2">
            {showContext ? (
              <p>
                Org context: <span className="font-medium">{state.platformContext.orgName ?? state.platformContext.orgId}</span>
                {" · "}
                started {formatDateTime(state.platformContext.startedAt)}
              </p>
            ) : null}
            {showImpersonation ? (
              <p>
                Impersonating:{" "}
                <span className="font-medium">
                  {state.impersonation.targetName ?? state.impersonation.targetEmail ?? state.impersonation.targetUserId}
                </span>
                {" · "}expires {formatDateTime(state.impersonation.expiresAt)}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {showImpersonation ? (
                <form action={endImpersonationAction}>
                  <Button size="sm" variant="destructive" type="submit">
                    End impersonation
                  </Button>
                </form>
              ) : null}
              {showContext ? (
                <form action={clearOrgContextAction}>
                  <Button size="sm" variant="outline" type="submit">
                    Exit org context
                  </Button>
                </form>
              ) : null}
            </div>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  )
}
