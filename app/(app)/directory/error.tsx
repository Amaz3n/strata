"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DirectoryError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The directory"
      backHref="/directory"
      backLabel="Back to directory"
      hint="Nothing was changed. Compliance and payment status are unknown until this loads, so treat any vendor as unverified for now."
    />
  )
}
