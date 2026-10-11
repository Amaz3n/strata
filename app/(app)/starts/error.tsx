"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function StartsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The Starts desk"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
