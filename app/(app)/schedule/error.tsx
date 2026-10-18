"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ScheduleError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="The Schedule desk" backHref="/" backLabel="Back to home" />
}
