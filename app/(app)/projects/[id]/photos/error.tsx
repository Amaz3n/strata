"use client"

import { Button } from "@/components/ui/button"

export default function ProjectPhotosError({ reset }: { reset: () => void }) {
  return (
    <div className="m-6 border p-8 text-center">
      <h2 className="font-semibold">Photos could not be loaded</h2>
      <p className="mt-2 text-sm text-muted-foreground">Check your connection and try again.</p>
      <Button className="mt-4" variant="outline" onClick={reset}>Try again</Button>
    </div>
  )
}
