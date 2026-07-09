"use client"

import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import type { OrgAccessState } from "@/lib/services/access"

function daysLeft(date: string) {
  const end = new Date(date).getTime()
  const now = Date.now()
  return Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)))
}

export function TrialStatusBanner({ access }: { access: OrgAccessState }) {
  const storageKey = useMemo(() => `arc-trial-banner:${access.trialEndsAt ?? "unknown"}`, [access.trialEndsAt])
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    setDismissed(sessionStorage.getItem(storageKey) === "dismissed")
  }, [storageKey])

  if (access.status !== "trialing" || !access.trialEndsAt || dismissed) return null

  const left = daysLeft(access.trialEndsAt)
  const label = `Trial - ${left} day${left === 1 ? "" : "s"} left`

  return (
    <div className="border-b bg-muted/35 px-4 py-2 text-sm text-muted-foreground">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <span>{label}</span>
          {access.hasPrice && access.checkoutUrl ? (
            <>
              <span className="mx-2 text-border">|</span>
              <a className="font-medium text-foreground underline underline-offset-4" href={access.checkoutUrl}>
                Complete billing setup
              </a>
            </>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-none px-2"
          onClick={() => {
            sessionStorage.setItem(storageKey, "dismissed")
            setDismissed(true)
          }}
        >
          Dismiss
        </Button>
      </div>
    </div>
  )
}
