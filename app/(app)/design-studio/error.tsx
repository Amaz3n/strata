"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DesignStudioError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The design studio runway"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
