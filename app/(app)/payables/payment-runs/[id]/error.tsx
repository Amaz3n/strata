"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PaymentRunError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This payment run"
      backHref="/payables"
      backLabel="Back to payables"
      hint="No approval or payment action was taken. Try loading the frozen evidence again."
    />
  )
}
