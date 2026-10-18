"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function LeadIntakeSettingsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Lead intake settings"
      backHref="/settings"
      backLabel="Back to settings"
    />
  )
}
