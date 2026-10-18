"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ImportsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Imports"
      backHref="/settings"
      backLabel="Back to settings"
      hint="Check your import permission or try loading the batches again."
    />
  )
}
