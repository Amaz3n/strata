"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TemplatesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This template library"
      backHref="/settings"
      backLabel="Back to settings"
    />
  )
}
