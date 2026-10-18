"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function LandDealsError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <DeskErrorState error={error} retry={retry} subject="The land deals desk" backHref="/communities" backLabel="Back to communities" />
}
