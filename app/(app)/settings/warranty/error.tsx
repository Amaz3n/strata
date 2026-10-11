"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function WarrantySettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Warranty settings"
      backHref="/settings"
      backLabel="Back to settings"
    />
  )
}
