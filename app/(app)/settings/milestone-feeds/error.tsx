"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function MilestoneFeedsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Lender and title feeds"
      backHref="/settings"
      backLabel="Back to settings"
    />
  )
}
