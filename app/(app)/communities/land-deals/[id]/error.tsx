"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function LandDealError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="This land deal" backHref="/communities/land-deals" backLabel="Back to land deals" />
}
