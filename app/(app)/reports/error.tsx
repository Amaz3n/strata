"use client"

import { Button } from "@/components/ui/button"

export default function ReportsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">The Reports desk could not be loaded.</p>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
