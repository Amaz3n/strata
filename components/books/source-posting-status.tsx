"use client"
import { useEffect, useState } from "react"
import { loadBooksPostingStatusAction } from "@/app/(app)/books/posting-actions"
import type { BooksPostingState } from "@/lib/services/books/posting-state"

const copy: Record<BooksPostingState, string> = {
  posted: "Journal verified for this revision",
  pending: "No verified journal for this revision yet",
  blocked: "Posting blocked by a closed period. Ask your accountant to review an adjustment or reopen the period.",
  failed: "Posting needs attention. Ask your accountant to review the source coding and retry verification.",
}
export function SourcePostingStatus({ sourceType, sourceId, revision }: { sourceType: "invoice" | "vendor_bill" | "expense"; sourceId: string; revision?: string }) {
  const [result, setResult] = useState<Awaited<ReturnType<typeof loadBooksPostingStatusAction>> | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setResult(null)
    loadBooksPostingStatusAction({ sourceType, sourceId }).then(value => { if (active) setResult(value) }).catch(() => { if (active) setResult({ success: false, error: "Accounting status is unavailable" }) })
    return () => { active = false }
  }, [sourceType, sourceId, revision, refresh])
  if (result?.success && !result.data) return null
  return <div className="flex items-start justify-between gap-3 border-t py-3 text-xs" aria-live="polite">
    <div><p className="font-medium">Arc ledger{result?.success && result.data?.ledgerMode !== "official" ? ` · ${result.data?.ledgerMode}` : ""}</p>
      <p className="mt-1 text-muted-foreground">{!result ? "Checking posting…" : result.success && result.data ? copy[result.data.state] : "Accounting status is unavailable"}</p>
    </div>
    <button type="button" className="shrink-0 underline underline-offset-2" onClick={() => setRefresh(value => value + 1)} disabled={!result}>Refresh</button>
  </div>
}
