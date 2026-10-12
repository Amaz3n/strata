"use client"

import { useState, useTransition } from "react"

import { listElevationRevisionsAction } from "@/app/(app)/plans/actions"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { REVISION_HISTORY_CAP } from "@/lib/plans/product-revisions"
import type { ProductDefinitionRevisionDto } from "@/lib/services/home-product-revisions"

const FIELD_LABELS: Record<string, string> = {
  code: "Code",
  name: "Name",
  swing_applicable: "Swing",
  heated_sqft_delta: "Sqft delta",
  is_active: "Active",
  house_plan_id: "Plan",
}

function describe(value: unknown) {
  if (typeof value === "boolean") return value ? "yes" : "no"
  if (value === null || value === undefined || value === "") return "—"
  return String(value)
}

/** The fields a revision changed from the one before it; the first revision lists none. */
function changedFields(revision: ProductDefinitionRevisionDto, previous: ProductDefinitionRevisionDto | undefined) {
  if (!previous) return []
  return Object.keys(FIELD_LABELS).flatMap((key) =>
    JSON.stringify(revision.snapshot[key]) === JSON.stringify(previous.snapshot[key])
      ? []
      : [`${FIELD_LABELS[key]} ${describe(previous.snapshot[key])} → ${describe(revision.snapshot[key])}`],
  )
}

/**
 * An elevation's revision number, opening its history. Homes record the
 * revision they were sold and released against, so this is how a builder reads
 * what "elevation B r2" was.
 */
export function ElevationRevisionHistory({ elevationId, code, revision }: { elevationId: string; code: string; revision: number }) {
  const [history, setHistory] = useState<ProductDefinitionRevisionDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()

  function load(open: boolean) {
    if (!open) return
    startLoading(async () => {
      const result = await listElevationRevisionsAction(elevationId)
      if (result.success) {
        setHistory(result.data)
        setError(null)
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <Popover onOpenChange={load}>
      <PopoverTrigger
        aria-label={`Elevation ${code} revision history`}
        className="font-mono text-[10px] text-muted-foreground tabular-nums transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        r{revision}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <p className="border-b px-3 py-2 text-[10px] uppercase tracking-wide text-muted-foreground">Elevation {code} revisions</p>
        {loading && !history ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ) : error ? (
          <p className="p-3 text-xs text-destructive">{error}</p>
        ) : !history || history.length === 0 ? (
          <p className="p-3 text-xs text-muted-foreground">No revisions recorded yet.</p>
        ) : (
          <ol className="max-h-72 divide-y overflow-y-auto">
            {history.map((entry, index) => {
              const truncated = history.length >= REVISION_HISTORY_CAP
              const changes = changedFields(entry, history[index + 1])
              return (
                <li key={entry.revision} className="px-3 py-2 text-xs">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono font-medium tabular-nums">r{entry.revision}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">{new Date(entry.createdAt).toLocaleDateString()}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {changes.length ? changes.join(" · ") : index === history.length - 1 && !truncated ? "First recorded definition" : "No definition change"}
                  </p>
                </li>
              )
            })}
          </ol>
        )}
        {history && history.length >= REVISION_HISTORY_CAP ? (
          <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">Showing the latest {REVISION_HISTORY_CAP} revisions.</p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
