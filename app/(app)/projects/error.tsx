"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DeskErrorState error={error} reset={reset} subject="The projects list" backHref="/" backLabel="Back to home" />
}
