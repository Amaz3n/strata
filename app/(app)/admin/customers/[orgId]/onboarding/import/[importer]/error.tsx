"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ImporterError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This importer"
      backHref="/admin"
      backLabel="Back to admin"
      hint="The batch or its staged rows could not be loaded."
    />
  )
}
