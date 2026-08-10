"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Check } from "lucide-react"

import { checkDrawingSetCoherenceAction } from "@/app/(app)/drawings/actions"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import type { CoherenceSeverity } from "@/lib/drawings/set-coherence"
import type { ProjectSetCoherenceReport } from "@/lib/services/drawings-set-coherence"
import { cn } from "@/lib/utils"

/**
 * "Is this set complete?" — the callout graph, read as a checklist.
 *
 * The first finding is always the one that costs a site visit: a sheet the
 * drawings tell you to look at that was never issued. Numbering gaps sit at the
 * bottom because they are usually deliberate, and a check that leads with those
 * is a check people stop opening.
 */

interface SetCoherenceSheetProps {
  projectId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SEVERITY_STYLES: Record<CoherenceSeverity, string> = {
  high: "border-destructive/40 bg-destructive/10 text-destructive",
  medium: "border-warning/40 bg-warning/10 text-warning",
  low: "border-border bg-muted text-muted-foreground",
}

const SEVERITY_LABELS: Record<CoherenceSeverity, string> = {
  high: "Missing",
  medium: "Check",
  low: "Note",
}

export function SetCoherenceSheet({ projectId, open, onOpenChange }: SetCoherenceSheetProps) {
  const [report, setReport] = useState<ProjectSetCoherenceReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const result = unwrapAction(await checkDrawingSetCoherenceAction(projectId))
        if (!cancelled) setReport(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not check this set")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, projectId])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col rounded-none p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl sm:rounded-none"
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <SheetTitle>Set check</SheetTitle>
          <SheetDescription>
            Callouts, numbering and spec coverage, checked against the current register.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <CheckSkeleton />
          ) : error ? (
            <p className="px-6 py-8 text-sm text-destructive">{error}</p>
          ) : !report ? null : (
            <CheckBody report={report} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CheckBody({ report }: { report: ProjectSetCoherenceReport }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-px border-b bg-border">
        <Stat label="Sheets" value={report.sheetsChecked} />
        <Stat label="Callouts" value={report.calloutsChecked} />
        <Stat label="Missing sheets" value={report.missingSheets} alarm={report.missingSheets > 0} />
      </div>

      {report.truncated ? (
        <p className="border-b px-6 py-2.5 text-xs text-muted-foreground">
          This set is larger than the check covers — only the first {report.sheetsChecked} sheets were
          examined.
        </p>
      ) : null}

      {/* Not the same as "no references": say which it is. */}
      {report.sheetsWithoutCallouts > 0 ? (
        <p className="border-b px-6 py-2.5 text-xs text-muted-foreground">
          {report.sheetsWithoutCallouts}{" "}
          {report.sheetsWithoutCallouts === 1 ? "sheet has" : "sheets have"} no extracted callouts yet, so
          references from {report.sheetsWithoutCallouts === 1 ? "it is" : "they are"} not counted here.
        </p>
      ) : null}

      {report.findings.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
          <Check className="size-8 text-success" />
          <p className="text-sm font-medium">Nothing to flag</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Every callout resolves to a sheet in this set, and the numbering has no unexplained holes.
          </p>
        </div>
      ) : (
        <ul className="divide-y">
          {report.findings.map((finding, index) => (
            <li key={`${finding.kind}-${finding.subject}-${index}`} className="flex gap-3 px-6 py-3.5">
              <Badge
                variant="outline"
                className={cn("mt-px h-5 shrink-0 rounded-none font-normal", SEVERITY_STYLES[finding.severity])}
              >
                {SEVERITY_LABELS[finding.severity]}
              </Badge>
              <div className="min-w-0 text-sm">
                <p>{finding.message}</p>
                {finding.relatedSheets.length > 0 ? (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <AlertTriangle className="size-3 shrink-0" />
                    Referenced on {finding.relatedSheets.slice(0, 6).join(", ")}
                    {finding.relatedSheets.length > 6 ? ` +${finding.relatedSheets.length - 6} more` : ""}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

function Stat({ label, value, alarm }: { label: string; value: number; alarm?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="microlabel text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums", alarm && "text-destructive")}>{value}</p>
    </div>
  )
}

function CheckSkeleton() {
  return (
    <div>
      <div className="grid grid-cols-3 gap-px border-b bg-border">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="bg-card px-4 py-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-6 w-10" />
          </div>
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3 px-6 py-3.5">
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  )
}
