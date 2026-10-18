"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function OnboardingError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Onboarding"
      backHref="/admin"
      backLabel="Back to admin"
      hint="The organization or onboarding evidence could not be loaded."
    />
  )
}
