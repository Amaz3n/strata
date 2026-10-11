"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function SelectionSheetError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This selection sheet"
      backHref="/design-studio"
      backLabel="Back to Design Studio"
    />
  )
}
