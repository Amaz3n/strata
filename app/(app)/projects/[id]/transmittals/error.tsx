"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TransmittalsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Transmittals"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
