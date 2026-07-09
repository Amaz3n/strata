import { AlertTriangle } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

interface OrgInactiveScreenProps {
  orgName?: string | null
  reason?: string
  hasPrice?: boolean
  checkoutUrl?: string | null
  supportEmail?: string
}

export function OrgInactiveScreen({ orgName, reason, hasPrice, checkoutUrl, supportEmail = "support@arcnaples.com" }: OrgInactiveScreenProps) {
  const resolvedName = orgName?.trim() || "This organization"
  const isExpiredTrial = reason === "Trial expired."
  const title = isExpiredTrial
    ? hasPrice && checkoutUrl
      ? "Complete Your Subscription"
      : "Trial Ended"
    : "Organization Not Active"

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background">
      <div className="relative z-10 flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-xl border-destructive/25 shadow-xl">
          <CardHeader className="pb-3">
            <div className="mb-3 inline-flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <CardTitle className="text-2xl font-semibold tracking-tight">{title}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            {isExpiredTrial && !hasPrice ? (
              <>
                <p>
                  <span className="font-medium text-foreground">{resolvedName}</span> trial has ended. We'll be in touch to get you set up.
                </p>
                <p>
                  Questions can go to{" "}
                  <a className="font-medium text-foreground underline underline-offset-4" href={`mailto:${supportEmail}`}>
                    {supportEmail}
                  </a>
                  .
                </p>
              </>
            ) : isExpiredTrial && checkoutUrl ? (
              <>
                <p>
                  <span className="font-medium text-foreground">{resolvedName}</span> trial has ended. Complete your subscription to continue.
                </p>
                <Button asChild className="rounded-none">
                  <a href={checkoutUrl}>Complete billing setup</a>
                </Button>
              </>
            ) : (
              <>
                <p>
                  <span className="font-medium text-foreground">{resolvedName}</span> is currently not active, so access is
                  temporarily disabled.
                </p>
                {reason ? <p>Reason: {reason}</p> : null}
                <p>Please contact the Arc team if you need this organization reactivated.</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
