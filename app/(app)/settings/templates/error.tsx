"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TemplatesError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This template library"
      backHref="/settings"
      backLabel="Back to settings"
    />
  )
}
