"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DailyLogsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Daily logs"
      backHref="/projects"
      backLabel="Back to projects"
      hint="Your records haven't changed. Try loading this day again."
    />
  )
}
