"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DealFileError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This buyer file"
      backHref="/sales"
      backLabel="Back to Sales"
      hint="Reload the file to check the latest reservation, agreement and access before continuing."
    />
  )
}
