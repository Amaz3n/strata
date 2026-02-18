import { AlertTriangle } from "@/components/icons"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface OrgInactiveScreenProps {
  orgName?: string | null
  reason?: string
}

export function OrgInactiveScreen({ orgName, reason }: OrgInactiveScreenProps) {
  const resolvedName = orgName?.trim() || "This organization"

  return (
    <div className="relative min-h-screen w-full overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,hsl(var(--destructive)/0.12),transparent_45%),radial-gradient(circle_at_80%_10%,hsl(var(--primary)/0.08),transparent_40%),hsl(var(--background))]" />
      <div className="absolute inset-0 backdrop-blur-sm" />
      <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-xl border-destructive/25 shadow-xl">
          <CardHeader className="pb-3">
            <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight">Organization Not Active</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">{resolvedName}</span> is currently not active, so access is
              temporarily disabled.
            </p>
            {reason ? <p>Reason: {reason}</p> : null}
            <p>Please contact the Arc team if you need this organization reactivated.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
