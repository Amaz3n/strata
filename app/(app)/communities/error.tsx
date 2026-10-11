"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function CommunitiesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DeskErrorState error={error} reset={reset} subject="The communities list" backHref="/" backLabel="Back to home" />
}
