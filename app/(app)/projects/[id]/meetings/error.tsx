"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function MeetingsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Meeting minutes"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
