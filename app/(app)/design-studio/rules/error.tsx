"use client"

import { Button } from "@/components/ui/button"

export default function RulesError({ reset }: { reset: () => void }) {
  return (
    <div className="p-12 text-center">
      <p className="font-medium">Cutoff rules could not be loaded.</p>
      <Button className="mt-4 rounded-none" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
