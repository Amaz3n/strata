"use client"

import { Button } from "@/components/ui/button"

export default function StartsError({ reset }: { error: Error; reset: () => void }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"><p className="text-sm font-medium">The Starts desk could not be loaded.</p><p className="text-xs text-muted-foreground">Try again. If this is a new environment, confirm the Workstream 05 migrations are applied.</p><Button onClick={reset} size="sm" variant="outline">Try again</Button></div>
}
