"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TakeoffSettingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The condition library"
      backHref="/settings"
      backLabel="Back to settings"
      hint="Reading it needs takeoff access."
    />
  )
}
