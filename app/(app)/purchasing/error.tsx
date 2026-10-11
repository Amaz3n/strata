"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PurchasingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Purchasing"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
