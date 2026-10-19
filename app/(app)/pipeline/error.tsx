"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PipelineError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The pipeline"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
