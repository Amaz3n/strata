"use client"

import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return <div className="m-6 border p-6"><h2 className="text-base font-semibold">Unable to load onboarding</h2><p className="mt-1 text-sm text-muted-foreground">The organization or onboarding evidence could not be loaded.</p><Button className="mt-4" size="sm" variant="outline" onClick={reset}>Try again</Button></div>
}
