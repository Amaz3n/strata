"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function SalesError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The Sales desk"
      backHref="/"
      backLabel="Back to home"
    />
  )
}
