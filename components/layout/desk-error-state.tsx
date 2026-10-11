"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"
import { parsePermissionDenied, permissionLabel } from "@/lib/permission-denied"

interface DeskErrorStateProps {
  error: Error & { digest?: string }
  reset: () => void
  /** What failed to load, as the user names it: "The Tasks desk", "This house". */
  subject: string
  /** Where "Back to ..." goes, so a failure is never a dead end. */
  backHref: string
  backLabel: string
  /** Extra guidance for the generic failure. */
  hint?: string
}

/**
 * The one error state for desks and workbenches.
 *
 * A permission denial names the missing permission and who can grant it
 * (retrying cannot help, so it offers no retry). Anything else is a load
 * failure with a retry and a way back. The denial is recognised from the
 * error's digest, because Next replaces the message of a thrown error with a
 * hash in production.
 */
export function DeskErrorState({ error, reset, subject, backHref, backLabel, hint }: DeskErrorStateProps) {
  const denied = parsePermissionDenied(error)

  if (denied) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
        <p className="text-sm font-medium">You don&apos;t have access to this.</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {subject} needs {denied.length > 1 ? "one of these permissions" : "this permission"}:
        </p>
        <ul className="flex flex-col gap-1 text-xs">
          {denied.map((key) => (
            <li key={key}>
              <span className="font-medium">{permissionLabel(key)}</span>{" "}
              <span className="font-mono text-muted-foreground">{key}</span>
            </li>
          ))}
        </ul>
        <p className="max-w-md text-xs text-muted-foreground">
          An organization admin can grant it from Settings, Team. Nothing was changed.
        </p>
        <Button variant="outline" size="sm" asChild>
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <p className="text-sm font-medium">{subject} could not be loaded.</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {hint ?? "Nothing was changed. Try again, or go back and reopen it."}
      </p>
      {error.digest ? <p className="font-mono text-[11px] text-muted-foreground">Reference {error.digest}</p> : null}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={reset}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" asChild>
          <Link href={backHref}>{backLabel}</Link>
        </Button>
      </div>
    </div>
  )
}
