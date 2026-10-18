"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectDrawingsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The drawing register"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
