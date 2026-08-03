import { FolderOpenDot, ShieldCheck } from "lucide-react"

import { ExternalAuthForm } from "@/components/portal/account/external-auth-form"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

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
}: PortalAccountGateProps) {
  const title = hasExistingAccount ? "Sign in to continue" : "Claim your Arc account"
  const description = hasExistingAccount
    ? `This invite is tied to an Arc account. Sign in to open ${projectName}.`
    : emailLocked
      ? `${orgName} invited ${initialEmail} to access ${projectName}. Create your Arc account to continue.`
      : `${orgName} requires an Arc account to view ${projectName}.`

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="border border-border bg-card p-8 sm:p-10">
          <div className="space-y-6">
            <Badge variant="outline" className="w-fit">
              {tokenType === "bid" ? "Invitation to bid" : "Project invitation"}
            </Badge>
            <div className="space-y-3">
              <h1 className="max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
              <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">{description}</p>
            </div>

            <div className="border border-border/70 bg-background/80 p-4">
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Invite</p>
              <p className="mt-2 text-lg font-medium">{projectName}</p>
              <p className="text-sm text-muted-foreground">{orgName}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border border-border/70 bg-background/80 p-4">
                <ShieldCheck className="mb-3 size-5 text-muted-foreground" />
                <p className="text-sm font-medium">Secure access</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Your invite stays tied to your account instead of a one-off link.
                </p>
              </div>
              <div className="border border-border/70 bg-background/80 p-4">
                <FolderOpenDot className="mb-3 size-5 text-muted-foreground" />
                <p className="text-sm font-medium">Every builder, one sign-in</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Projects and bids from every builder who invites you open from the same account.
                </p>
              </div>
            </div>
          </div>
        </div>

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
      </div>
    </div>
  )
}
