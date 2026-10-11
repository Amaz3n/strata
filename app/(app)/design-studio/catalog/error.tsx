"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function CatalogError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The option catalog"
      backHref="/design-studio"
      backLabel="Back to Design Studio"
    />
  )
}
