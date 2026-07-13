"use client"

import { SpecsRegisterError } from "@/components/specs/specs-register-client"

export default function ProjectSpecsError({ reset }: { error: Error; reset: () => void }) {
  return <div className="p-6"><SpecsRegisterError retry={reset} /></div>
}
