"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This home"
      backHref="/projects"
      backLabel="Back to projects"
      hint="Try again. If the problem continues, confirm that you still have access to its division."
    />
  )
}
