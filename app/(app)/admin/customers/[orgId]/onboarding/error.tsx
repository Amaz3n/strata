"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function OnboardingError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <DeskErrorState
      error={error}
      reset={reset}
      subject="Onboarding"
      backHref="/admin"
      backLabel="Back to admin"
      hint="The organization or onboarding evidence could not be loaded."
    />
  )
}
