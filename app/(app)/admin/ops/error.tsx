"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function OpsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Ops health"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
