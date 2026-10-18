"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PayablesError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="Payables" backHref="/" backLabel="Back to home" />
}
