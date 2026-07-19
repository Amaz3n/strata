"use client"

import { Button } from "@/components/ui/button"

export default function MyHousesError({ reset }: { error: Error; reset: () => void }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"><p className="text-sm font-medium">My Houses could not be loaded.</p><Button onClick={reset} size="sm" variant="outline">Try again</Button></div>
}
