"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function DirectoryAccountError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="This account" backHref="/directory" backLabel="Back to directory" />
}
