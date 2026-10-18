"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function BooksError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The ledger workspace"
      backHref="/"
      backLabel="Back to home"
      hint="Nothing was changed. Try again."
    />
  )
}
