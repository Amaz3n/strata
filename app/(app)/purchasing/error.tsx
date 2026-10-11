"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PurchasingError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Purchasing"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
