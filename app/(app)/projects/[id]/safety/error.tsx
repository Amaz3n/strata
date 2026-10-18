"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectSafetyError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Safety records"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
