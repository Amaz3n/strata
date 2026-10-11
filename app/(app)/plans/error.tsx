"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function PlansError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="The Plans desk" backHref="/" backLabel="Back to home" />
}
