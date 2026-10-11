"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DrawingsDeadLetterError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Drawings pipeline dead letters"
      backHref="/admin/ops"
      backLabel="Back to ops health"
    />
  )
}
