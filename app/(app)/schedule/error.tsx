"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ScheduleError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DeskErrorState error={error} reset={reset} subject="The Schedule desk" backHref="/" backLabel="Back to home" />
}
