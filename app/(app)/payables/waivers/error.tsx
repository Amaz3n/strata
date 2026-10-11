"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function WaiverRegisterError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The waiver register"
      backHref="/payables"
      backLabel="Back to payables"
    />
  )
}
