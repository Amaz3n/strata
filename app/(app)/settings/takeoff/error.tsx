"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TakeoffSettingsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The condition library"
      backHref="/settings"
      backLabel="Back to settings"
      hint="Reading it needs takeoff access."
    />
  )
}
