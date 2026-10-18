"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DailyLogsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Daily logs"
      backHref="/projects"
      backLabel="Back to projects"
      hint="Your records haven't changed. Try loading this day again."
    />
  )
}
