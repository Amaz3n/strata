"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="The projects list" backHref="/" backLabel="Back to home" />
}
