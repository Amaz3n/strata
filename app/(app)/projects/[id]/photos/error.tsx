"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectPhotosError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Photos"
      backHref="/projects"
      backLabel="Back to projects"
      hint="Check your connection and try again."
    />
  )
}
