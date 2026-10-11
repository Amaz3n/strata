"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function OpsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Ops health"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
