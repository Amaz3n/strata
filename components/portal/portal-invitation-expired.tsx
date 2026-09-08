import { MailWarning } from "lucide-react"

import type { UnusablePortalTokenReason } from "@/lib/services/portal-access"

/**
 * The dead end a vendor reaches when their payout link no longer opens.
 *
 * A payout invitation is time-boxed on purpose, and the vendor who finally sits
 * down to do it three weeks later is the normal case, not the edge one. A 404
 * told them Arc was broken; this tells them what happened and who can fix it in
 * one sentence, which is the whole difference between a re-invite and a phone
 * call to the PM.
 *
 * Full-page rather than a card inside the portal chrome: there is no portal to
 * put chrome around — the token that would have loaded it is the thing that
 * expired.
 */
export function PortalInvitationExpired({
  reason,
  orgName,
}: {
  reason: UnusablePortalTokenReason
  orgName: string
}) {
  const copy =
    reason === "expired"
      ? {
        title: "This invitation expired",
        body: `Payment invitations are good for 30 days. Ask ${orgName} to send a new one and you can pick up where you left off — nothing you already entered is lost.`,
      }
      : reason === "revoked"
        ? {
          title: "This link was replaced",
          body: `${orgName} sent a newer payment invitation, and this one stopped working when they did. Check your inbox for the most recent email from them, or ask them to send it again.`,
        }
        : {
          title: "This invitation is not active",
          body: `${orgName} paused this payment invitation. Ask the person you normally invoice to send you a new one.`,
        }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md border border-border bg-card p-8" role="status">
        <MailWarning className="size-6 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy.body}</p>
        <p className="mt-6 text-xs text-muted-foreground">{orgName} runs on Arc</p>
      </div>
    </div>
  )
}
