"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function ReportError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">This report could not be built.</p>
      <p className="max-w-md text-sm text-muted-foreground">{error.message}</p>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
        <Button asChild variant="ghost" size="sm">
          <Link href="/reports">All reports</Link>
        </Button>
      </div>
    </div>
  )
}
