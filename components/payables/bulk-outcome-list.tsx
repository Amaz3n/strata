"use client"

import { Button } from "@/components/ui/button"

export interface BulkOutcome { id: string; label: string; ok: boolean; reason?: string | null }

export function BulkOutcomeList({ outcomes, onRetryFailures, retrying = false }: {
  outcomes: BulkOutcome[]
  onRetryFailures?: (ids: string[]) => void
  retrying?: boolean
}) {
  if (outcomes.length === 0) return null
  const failed = outcomes.filter((outcome) => !outcome.ok)
  return (
    <section className="border" aria-live="polite">
      <div className="flex items-center justify-between border-b bg-muted/20 px-3 py-2">
        <p className="text-xs font-medium">{outcomes.length - failed.length} succeeded · {failed.length} failed</p>
        {failed.length > 0 && onRetryFailures ? (
          <Button size="sm" variant="outline" className="h-7 rounded-none text-xs" disabled={retrying}
            onClick={() => onRetryFailures(failed.map((outcome) => outcome.id))}>
            {retrying ? "Retrying…" : "Retry the ones that failed"}
          </Button>
        ) : null}
      </div>
      <ul className="max-h-56 divide-y overflow-y-auto">
        {outcomes.map((outcome) => (
          <li key={outcome.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-3 py-2 text-xs">
            <span className="truncate">{outcome.label}</span>
            <span className={outcome.ok ? "text-success" : "max-w-72 text-right text-destructive"}>
              {outcome.ok ? "Succeeded" : outcome.reason || "Could not complete"}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
