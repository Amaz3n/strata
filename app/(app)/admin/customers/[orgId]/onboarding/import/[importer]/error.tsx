"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ImporterError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This importer"
      backHref="/admin"
      backLabel="Back to admin"
      hint="The batch or its staged rows could not be loaded."
    />
  )
}
