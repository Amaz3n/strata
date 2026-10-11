"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"

export default function CertifiedPayrollError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <DeskErrorState
      error={error}
      retry={retry}
      subject="Certified payroll"
      backHref="/projects"
      backLabel="Back to projects"
    />
  )
}
