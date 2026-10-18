"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectReleasedError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Released documents"
      backHref="/projects"
      backLabel="Back to projects"
      hint="Check your connection and try again."
    />
  )
}
