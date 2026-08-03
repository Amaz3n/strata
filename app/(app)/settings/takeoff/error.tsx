"use client"

import { Button } from "@/components/ui/button"

export default function TakeoffSettingsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-5 py-6 lg:px-8 lg:py-8">
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <p className="max-w-sm text-sm text-destructive">
          We couldn&apos;t load the condition library. Reading it needs takeoff access.
        </p>
        <Button size="sm" variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  )
}
