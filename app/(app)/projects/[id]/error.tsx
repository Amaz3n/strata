"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This home"
      backHref="/projects"
      backLabel="Back to projects"
      hint="Try again. If the problem continues, confirm that you still have access to its division."
    />
  )
}
