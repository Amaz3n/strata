"use client"
import { Button } from "@/components/ui/button"
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <div className="space-y-3 p-6" role="alert">
      <p>Could not load the waiver register.</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
