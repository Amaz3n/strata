"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DrawingsDeadLetterError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Drawings pipeline dead letters"
      backHref="/admin/ops"
      backLabel="Back to ops health"
    />
  )
}
