"use client"

import { Button } from "@/components/ui/button"

export default function PaymentRunError({ reset }: { error: Error; reset: () => void }) {
  return <div className="mx-auto flex min-h-64 max-w-2xl flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
    <p className="text-sm font-medium">This payment run could not be loaded.</p>
    <p className="text-xs text-muted-foreground">No approval or payment action was taken. Try loading the frozen evidence again.</p>
    <Button variant="outline" size="sm" onClick={reset}>Try again</Button>
  </div>
}
