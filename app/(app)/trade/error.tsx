"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TradeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Arc Trade"
      backHref="/"
      backLabel="Back to home"
      hint="If this continues, ask your company administrator to check your access."
    />
  )
}
