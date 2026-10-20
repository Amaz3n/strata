"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ExpensesError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="Expenses" backHref="/payables" backLabel="Back to payables" />
}
