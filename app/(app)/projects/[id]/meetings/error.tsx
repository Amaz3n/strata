"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function MeetingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Meeting minutes"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
