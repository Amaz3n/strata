"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ReportError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This report"
      backHref="/reports"
      backLabel="All reports"
    />
  )
}
