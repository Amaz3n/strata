"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function BooksError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The ledger workspace"
      backHref="/"
      backLabel="Back to home"
      hint="Nothing was changed. Try again."
    />
  )
}
