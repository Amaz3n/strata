"use client"

import { useState } from "react"

import { ShieldCheck } from "@/components/icons"
import { TwoFactorField } from "@/components/settings/two-factor-field"
import { Button } from "@/components/ui/button"
import { createClient } from "@/lib/supabase/client"

/**
 * Where a member lands when their organization requires two-factor and they have
 * not set it up. Reuses the account-settings enrollment flow, so there is one
 * way to enroll. Continuing is a full navigation: the proxy re-evaluates the
 * session, which Supabase has raised to aal2 once the first code is verified.
 */
export function MfaEnrollmentRequired() {
  const [signingOut, setSigningOut] = useState(false)

  const signOut = async () => {
    setSigningOut(true)
    await createClient().auth.signOut()
    window.location.assign("/auth/signin")
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex size-12 items-center justify-center bg-primary/10 text-primary">
          <ShieldCheck className="size-6" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Set up two-factor</h1>
        <p className="text-sm text-muted-foreground text-balance">
          Your organization requires two-factor authentication. Set it up to continue.
        </p>
      </div>

      <TwoFactorField layout="stacked" />

      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Button type="button" onClick={() => window.location.assign("/")}>
          Continue
        </Button>
        <Button type="button" variant="outline" onClick={signOut} disabled={signingOut}>
          Sign out
        </Button>
      </div>
    </div>
  )
}
