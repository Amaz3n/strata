"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function RulesError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Cutoff rules"
      backHref="/design-studio"
      backLabel="Back to Design Studio"
    />
  )
}
