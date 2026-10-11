"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function CommunityError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="This community"
      backHref="/communities"
      backLabel="Back to communities"
    />
  )
}
