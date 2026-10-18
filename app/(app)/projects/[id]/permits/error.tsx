"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PermitsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Permits"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
