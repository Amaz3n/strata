"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DealError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This deal"
      backHref="/pipeline"
      backLabel="Back to pipeline"
      hint="It may have been removed, or you may not have access to its project."
    />
  )
}
