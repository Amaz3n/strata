"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectDrawingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The drawing register"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
