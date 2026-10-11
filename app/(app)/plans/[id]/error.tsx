"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PlanDetailError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="This plan" backHref="/plans" backLabel="Back to plans" />
}
