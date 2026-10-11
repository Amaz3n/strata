"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectSafetyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Safety records"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
