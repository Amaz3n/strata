"use client"

import { Button } from "@/components/ui/button"

export default function CommunityError({ reset }: { error: Error; reset: () => void }) {
  return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center"><p className="text-sm font-medium">The community could not be loaded.</p><p className="text-xs text-muted-foreground">Try again. If the problem continues, confirm the Stage 01 migrations have been applied.</p><Button variant="outline" size="sm" onClick={reset}>Try again</Button></div>
}
