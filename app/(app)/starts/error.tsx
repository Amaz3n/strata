"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function StartsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The Starts desk"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
