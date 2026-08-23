"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * The directory decides who gets paid, so a failed load has to read as a
 * failure. Without this boundary, errors here fell through to the workspace
 * shell's generic message — and the surfaces below used to turn them into
 * "not found" or an empty all-clear, which told the user a vendor was compliant
 * when Arc simply could not check.
 */
export default function DirectoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm font-medium">The directory could not be loaded.</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Nothing was changed. Compliance and payment status are unknown until this loads, so
        treat any vendor as unverified for now.
      </p>
      {error.digest ? (
        <p className="font-mono text-[11px] text-muted-foreground">Reference {error.digest}</p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/directory">Back to directory</Link>
        </Button>
      </div>
    </div>
  )
}
