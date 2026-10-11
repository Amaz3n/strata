"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function InspectionsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Inspections"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
