"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function WarrantyDeskError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The warranty desk"
      backHref="/"
      backLabel="Back to home"
      hint="Reading service requests across homes needs the warranty permission."
    />
  )
}
