"use client"

import { AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function ProjectDrawingsError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertTriangle className="h-6 w-6 text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Drawings could not be loaded</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {error.message || "Something went wrong loading this project's drawing register."}
        </p>
        {error.digest && (
          <p className="font-mono text-[11px] text-muted-foreground">Ref {error.digest}</p>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
