"use client"

import { DeskErrorState } from "@/components/layout/desk-error-state"
import { SpecsRegisterError } from "@/components/specs/specs-register-client"
import { parsePermissionDenied } from "@/lib/permission-denied"

export default function ProjectSpecsError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  if (parsePermissionDenied(error)) {
    return <DeskErrorState error={error} retry={retry} subject="The specification register" backHref="/projects" backLabel="Back to projects" />
  }
  return <div className="p-6"><SpecsRegisterError retry={retry} /></div>
}
