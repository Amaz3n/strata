"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PayablesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DeskErrorState error={error} reset={reset} subject="Payables" backHref="/" backLabel="Back to home" />
}
