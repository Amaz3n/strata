"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function SalesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The Sales desk"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
