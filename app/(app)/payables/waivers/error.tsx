"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function WaiverRegisterError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The waiver register"
      backHref="/payables"
      backLabel="Back to payables"
    />
  )
}
