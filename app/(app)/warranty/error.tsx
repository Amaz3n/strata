"use client"

import { Button } from "@/components/ui/button"

export default function WarrantyDeskError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <p className="max-w-sm text-sm text-destructive">
        We couldn&apos;t load the warranty desk. Reading service requests across homes needs the warranty permission.
      </p>
      <Button size="sm" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
