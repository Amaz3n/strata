"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This workspace"
      backHref="/"
      backLabel="Back to home"
      hint="Try again. If the problem continues, check your organization and division access."
    />
  )
}
