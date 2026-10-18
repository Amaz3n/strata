"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function CatalogError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The option catalog"
      backHref="/design-studio"
      backLabel="Back to Design Studio"
    />
  )
}
