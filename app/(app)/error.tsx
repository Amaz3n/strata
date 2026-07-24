"use client"

import { Button } from "@/components/ui/button"

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">This workspace could not be loaded.</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Try again. If the problem continues, check your organization and division access.
      </p>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
