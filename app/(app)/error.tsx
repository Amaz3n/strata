"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This workspace"
      backHref="/"
      backLabel="Back to home"
      hint="Try again. If the problem continues, check your organization and division access."
    />
  )
}
