"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function RulesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Cutoff rules"
      backHref="/design-studio"
      backLabel="Back to Design Studio"
    />
  )
}
