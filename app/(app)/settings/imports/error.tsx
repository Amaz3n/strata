"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ImportsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Imports"
      backHref="/settings"
      backLabel="Back to settings"
      hint="Check your import permission or try loading the batches again."
    />
  )
}
