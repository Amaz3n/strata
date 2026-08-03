"use client"

import { useState } from "react"

import { ExternalAuthForm } from "@/components/portal/account/external-auth-form"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

interface PortalClaimAccountProps {
  token: string
  tokenType: "portal" | "bid"
  /** Prefilled from the invite; locked when present so the grant still matches. */
  email?: string
  suggestedFullName?: string
}

/**
 * Offers a free account to someone who arrived on a direct link, so their portals
 * collect in one workspace. Deliberately a quiet header affordance — it is an
 * upsell, and the sub came here to do a job.
 *
 * Only ever reached by someone with no Arc account: the gate turns a claimed
 * access into a sign-in wall before the shell renders.
 */
export function PortalClaimAccount({
  token,
  tokenType,
  email = "",
  suggestedFullName = "",
}: PortalClaimAccountProps) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="hidden sm:inline-flex">
          Save my access
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Save your access</DialogTitle>
          <DialogDescription>
            Create a free account with your invited email and every portal you are invited to
            collects in one place — no more hunting for links in email.
          </DialogDescription>
        </DialogHeader>
        <ExternalAuthForm
          token={token}
          tokenType={tokenType}
          hasExistingAccount={false}
          initialEmail={email}
          suggestedFullName={suggestedFullName}
          emailLocked={!!email}
          idPrefix="portal-claim"
          onAuthenticated={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
