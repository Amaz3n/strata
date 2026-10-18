"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PipelineFailuresError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Failed production work"
      backHref="/admin/ops"
      backLabel="Back to ops health"
    />
  )
}
