import { Banknote, FolderOpenDot, ShieldCheck } from "lucide-react"

import { ExternalAuthForm } from "@/components/portal/account/external-auth-form"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { PortalTokenPurpose } from "@/lib/types"

interface PortalAccountGateProps {
  token: string
  tokenType: "portal" | "bid"
  orgName: string
  projectName: string
  initialEmail?: string
  suggestedFullName?: string
  emailLocked?: boolean
  /** Resolved by the gate: this access is already tied to an Arc account. */
  hasExistingAccount?: boolean
  /**
   * A payout invitation, not a project invitation. The account is a step on the
   * way to being paid, and saying so is the difference between a vendor
   * finishing and a vendor deciding the email was for someone else.
   */
  purpose?: PortalTokenPurpose
  /**
   * `page` is the full-bleed wall the portal gate renders in place of the
   * shell. `section` is the same wall rendered *inside* an already-mounted
   * portal, where the chrome, the nav and the builder's masthead are all
   * present already — so the marketing column would be a second masthead and
   * `min-h-screen` would be a second screen.
   */
  layout?: "page" | "section"
}

/**
 * The full-page wall shown when a token is not sufficient on its own — either the
 * builder requires an account, or the invited person already has one, in which
 * case the link is a pointer to a sign-in rather than a credential.
 */
export function PortalAccountGate({
  token,
  tokenType,
  orgName,
  projectName,
  initialEmail = "",
  suggestedFullName = "",
  emailLocked = false,
  hasExistingAccount = false,
  purpose = "portal",
  layout = "page",
}: PortalAccountGateProps) {
  const isPayout = purpose === "vendor_payout"
  const title = hasExistingAccount
    ? "Sign in to continue"
    : isPayout
      ? `Create your Arc account to get paid by ${orgName}`
      : "Claim your Arc account"
  const description = hasExistingAccount
    ? isPayout
      ? `This payment invitation is tied to an Arc account. Sign in to set up direct deposit from ${orgName}.`
      : `This invite is tied to an Arc account. Sign in to open ${projectName}.`
    : isPayout
      ? `${orgName} wants to pay ${projectName} by bank transfer instead of by check. Your account is what keeps your payout bank yours — ${orgName} never sees or enters it.`
      : emailLocked
        ? `${orgName} invited ${initialEmail} to access ${projectName}. Create your Arc account to continue.`
        : `${orgName} requires an Arc account to view ${projectName}.`

  const form = (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        <div className="mb-4 border border-border bg-muted/30 p-3 text-sm">
          <p className="font-medium">{projectName}</p>
          <p className="text-muted-foreground">{orgName}</p>
        </div>

        <ExternalAuthForm
          token={token}
          tokenType={tokenType}
          hasExistingAccount={hasExistingAccount}
          initialEmail={initialEmail}
          suggestedFullName={suggestedFullName}
          emailLocked={emailLocked}
          idPrefix="portal-gate"
        />
      </CardContent>
    </Card>
  )

  if (layout === "section") {
    return <div className="max-w-xl desk-rise">{form}</div>
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="border border-border bg-card p-8 sm:p-10">
          <div className="space-y-6">
            <Badge variant="outline" className="w-fit">
              {isPayout ? "Payment invitation" : tokenType === "bid" ? "Invitation to bid" : "Project invitation"}
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">{description}</p>
            </div>

            <div className="border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
                {isPayout ? "Getting paid" : "Invite"}
              </p>
              <p className="mt-2 text-lg font-medium">{projectName}</p>
              <p className="text-sm text-muted-foreground">{orgName}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-border/70 bg-background/80 p-4">
                {isPayout ? (
                  <Banknote className="mb-3 size-5 text-muted-foreground" />
                ) : (
                  <ShieldCheck className="mb-3 size-5 text-muted-foreground" />
                )}
                <p className="text-sm font-medium">{isPayout ? "Your bank stays yours" : "Secure access"}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isPayout
                    ? "You enter your payout bank with Stripe, not with the builder. Only your account can change it."
                    : "Your invite stays tied to your account instead of a one-off link."}
                </p>
              </div>
              <div className="border border-border/70 bg-background/80 p-4">
                <FolderOpenDot className="mb-3 size-5 text-muted-foreground" />
                <p className="text-sm font-medium">Every builder, one sign-in</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {isPayout
                    ? "Verify once. The same account gets you paid by every Arc builder you work with."
                    : "Projects and bids from every builder who invites you open from the same account."}
                </p>
              </div>
            </div>
          </div>
        </div>

        {form}
      </div>
    </div>
  )
}
