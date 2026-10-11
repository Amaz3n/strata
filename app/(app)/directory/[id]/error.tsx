"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DirectoryAccountError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <DeskErrorState error={error} reset={reset} subject="This account" backHref="/directory" backLabel="Back to directory" />
}
