"use client"

import { Button } from "@/components/ui/button"

export default function PurchasingError({ reset }: { error: Error; reset: () => void }) {
  return <div className="flex min-h-80 flex-col items-center justify-center gap-3 p-6 text-center"><p className="font-medium">Purchasing could not be loaded.</p><p className="text-sm text-muted-foreground">Check that the purchasing migrations are applied, then try again.</p><Button variant="outline" onClick={reset}>Try again</Button></div>
}
