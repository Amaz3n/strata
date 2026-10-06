"use client"

import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function DealFileError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p className="text-sm font-medium">This buyer file could not be loaded.</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Reload the file to check the latest reservation, agreement and access before continuing.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={retry}>Try again</Button>
        <Button variant="ghost" size="sm" asChild><Link href="/sales">Back to Sales</Link></Button>
      </div>
    </div>
  )
}
