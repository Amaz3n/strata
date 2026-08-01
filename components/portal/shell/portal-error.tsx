"use client"

import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * Recovery surface for a portal page that failed to render. Externals cannot
 * read a stack trace or open a ticket, so this offers the one action that
 * usually works and names who to contact when it does not.
 */
export function PortalErrorState({ reset }: { reset: () => void }) {
  return (
    <div className="border border-border bg-card px-4 py-10 text-center">
      <AlertTriangle className="mx-auto mb-3 size-8 text-warning" />
      <p className="text-sm font-medium text-foreground">This page could not be loaded</p>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">
        Something went wrong on our end. Try again — if it keeps happening, reply to the email that
        sent you this link and the builder can help.
      </p>
      <Button onClick={reset} variant="outline" size="sm" className="mt-4">
        Try again
      </Button>
    </div>
  )
}
