"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function TasksError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DeskErrorState error={error} reset={reset} subject="The Tasks desk" backHref="/" backLabel="Back to home" />
}
