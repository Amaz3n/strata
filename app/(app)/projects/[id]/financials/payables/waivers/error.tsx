"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function ProjectWaiverRegisterError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="The waiver register"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
