"use client"

import { Button } from "@/components/ui/button"

export default function DailyLogsError({ reset }: { reset: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
      <h2 className="text-base font-semibold">Daily logs couldn’t be loaded</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Your records haven’t changed. Try loading this day again.
      </p>
      <Button variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
