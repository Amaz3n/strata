"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ReportError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This report"
      backHref="/reports"
      backLabel="All reports"
    />
  )
}
