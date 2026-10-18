"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DealError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This deal"
      backHref="/pipeline"
      backLabel="Back to pipeline"
      hint="It may have been removed, or you may not have access to its project."
    />
  )
}
