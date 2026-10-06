"use client"
import Link from "next/link"
import { useEffect, useState } from "react"
import { loadBooksPostingStatusAction } from "@/app/(app)/books/posting-actions"
import type { BooksPostingState } from "@/lib/services/books/posting-state"
import type { BooksPostingSourceType } from "@/lib/services/books/posting-status"
import { cn } from "@/lib/utils"

const copy: Record<BooksPostingState, string> = {
  posted: "Journal verified for this revision",
  pending: "No verified journal for this revision yet",
  reversed: "Journal reversed. This document no longer carries money in the ledger",
  blocked: "Posting blocked by a closed period. Ask your accountant to review an adjustment or reopen the period.",
  failed: "Posting needs attention. Ask your accountant to review the source coding and retry verification.",
}
const tone: Record<BooksPostingState, string> = {
  posted: "text-success",
  pending: "text-muted-foreground",
  reversed: "text-muted-foreground",
  blocked: "text-warning",
  failed: "text-destructive",
}

/** Where this document stands in the Arc ledger, with the journal or the cure one click away. */
export function SourcePostingStatus({ sourceType, sourceId, revision }: { sourceType: BooksPostingSourceType; sourceId: string; revision?: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof loadBooksPostingStatusAction>> | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setResult(null)
    loadBooksPostingStatusAction({ sourceType, sourceId }).then(value => { if (active) setResult(value) }).catch(() => { if (active) setResult({ success: false, error: "Accounting status is unavailable" }) })
    return () => { active = false }
  }, [sourceType, sourceId, revision, refresh])
  if (result?.success && !result.data) return null
  const status = result?.success ? result.data : null
  return <section aria-label="Accounting posting" aria-live="polite" className="flex items-start justify-between gap-3 border-t py-3 text-xs">
    <div className="min-w-0">
      <p className="font-medium">Arc ledger{status && status.ledgerMode !== "official" ? ` · ${status.ledgerMode}` : ""}</p>
      <p className={cn("mt-1", status ? tone[status.state] : "text-muted-foreground")}>{!result ? "Checking posting…" : status ? copy[status.state] : "Accounting status is unavailable"}</p>
      {status?.finding?.error ? <p className="mt-1 text-muted-foreground">{status.finding.error}</p> : null}
      <div className="mt-1 flex flex-wrap gap-3">
        {status?.journalHref && status.state !== "failed" ? <Link className="underline underline-offset-2" href={status.journalHref}>Journal {status.journalEntryDate}</Link> : null}
        {status?.finding?.href && (status.state === "blocked" || status.state === "failed") ? <Link className="underline underline-offset-2" href={status.finding.href}>Resolve in Books</Link> : null}
      </div>
    </div>
    <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setRefresh(value => value + 1)} disabled={!result}>Refresh</button>
  </section>
}
