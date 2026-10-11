"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PaymentRunError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This payment run"
      backHref="/payables"
      backLabel="Back to payables"
      hint="No approval or payment action was taken. Try loading the frozen evidence again."
    />
  )
}
