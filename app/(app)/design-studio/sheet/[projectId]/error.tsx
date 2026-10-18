"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function SelectionSheetError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This selection sheet"
      backHref="/design-studio"
      backLabel="Back to Design Studio"
    />
  )
}
