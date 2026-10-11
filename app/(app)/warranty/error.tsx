"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function WarrantyDeskError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="The warranty desk"
      backHref="/"
      backLabel="Back to home"
      hint="Reading service requests across homes needs the warranty permission."
    />
  )
}
