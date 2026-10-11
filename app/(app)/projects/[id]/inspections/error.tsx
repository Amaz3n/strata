"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function InspectionsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Inspections"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
