"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function CommunityError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="This community"
      backHref="/communities"
      backLabel="Back to communities"
    />
  )
}
