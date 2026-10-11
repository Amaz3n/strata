"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DesignStudioError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The design studio runway"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
