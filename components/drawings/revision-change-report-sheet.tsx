"use client"

import { useEffect, useState } from "react"
import { AlertTriangle, Check, FileText } from "lucide-react"

import { getRevisionChangeReportAction } from "@/app/(app)/drawings/actions"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import { CHANGE_KIND_LABELS, type ChangeKind, type ChangeSeverity } from "@/lib/drawings/change-impact"
import type { RevisionChangeReport, SheetChangeReport } from "@/lib/services/drawings-change-semantics"
import { cn } from "@/lib/utils"

/**
 * "What changed in this issuance" — the report the pixel diff was always
 * missing a reader for.
 *
 * The ordering is the feature. Sheets with work priced off the changed area
 * come first, then sheets with the most changed area; within a sheet the same
 * rule applies to regions. A superintendent who reads only the first screen
 * should have seen everything that costs money.
 */

interface RevisionChangeReportSheetProps {
  revisionId: string | null
  revisionLabel: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Jump the register to a sheet the reviewer wants to open. */
  onOpenSheet?: (sheetId: string) => void
}

const SEVERITY_STYLES: Record<ChangeSeverity, string> = {
  high: "border-destructive/40 bg-destructive/10 text-destructive",
  medium: "border-warning/40 bg-warning/10 text-warning",
  low: "border-border bg-muted text-muted-foreground",
}

export function RevisionChangeReportSheet({
  revisionId,
  revisionLabel,
  open,
  onOpenChange,
  onOpenSheet,
}: RevisionChangeReportSheetProps) {
  const [report, setReport] = useState<RevisionChangeReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !revisionId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const result = unwrapAction(await getRevisionChangeReportAction(revisionId))
        if (!cancelled) setReport(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the change report")
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, revisionId])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col rounded-none p-0 shadow-2xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-xl sm:rounded-none"
      >
        <SheetHeader className="border-b bg-muted/30 px-6 pb-4 pt-6">
          <SheetTitle>What changed</SheetTitle>
          <SheetDescription>
            {revisionLabel} — compared sheet by sheet against the issuance it replaced.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <ReportSkeleton />
          ) : error ? (
            <p className="px-6 py-8 text-sm text-destructive">{error}</p>
          ) : !report ? null : (
            <ReportBody report={report} onOpenSheet={onOpenSheet} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ReportBody({
  report,
  onOpenSheet,
}: {
  report: RevisionChangeReport
  onOpenSheet?: (sheetId: string) => void
}) {
  if (report.sheets.length === 0 && report.unchangedSheets === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <FileText className="size-8 text-muted-foreground" />
        <p className="text-sm font-medium">No comparison yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Sheets are compared against the previous issuance shortly after publishing. Check back in a
          few minutes.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-3 gap-px border-b bg-border">
        <Stat label="Sheets changed" value={report.sheets.length} />
        <Stat
          label="Needs attention"
          value={report.totalHighSeverityRegions}
          alarm={report.totalHighSeverityRegions > 0}
        />
        <Stat label="Affected takeoffs" value={report.totalAffectedRecords} />
      </div>

      {report.unchangedSheets > 0 ? (
        <p className="border-b px-6 py-2.5 text-xs text-muted-foreground">
          <Check className="mr-1.5 inline size-3 text-success" />
          {report.unchangedSheets} {report.unchangedSheets === 1 ? "sheet is" : "sheets are"} byte-for-byte
          identical to the previous issuance.
        </p>
      ) : null}

      {/* A sheet whose classification has not run is NOT reported as clean. */}
      {report.unclassifiedSheets > 0 ? (
        <p className="border-b px-6 py-2.5 text-xs text-muted-foreground">
          {report.unclassifiedSheets} changed {report.unclassifiedSheets === 1 ? "sheet has" : "sheets have"}{" "}
          not been classified — those show the changed area only.
        </p>
      ) : null}

      <div className="divide-y">
        {report.sheets.map((sheet) => (
          <SheetRow key={sheet.sheetVersionId} sheet={sheet} onOpenSheet={onOpenSheet} />
        ))}
      </div>
    </>
  )
}

function SheetRow({
  sheet,
  onOpenSheet,
}: {
  sheet: SheetChangeReport
  onOpenSheet?: (sheetId: string) => void
}) {
  const summary = sheet.semantics?.summary

  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            type="button"
            onClick={() => onOpenSheet?.(sheet.sheetId)}
            disabled={!onOpenSheet}
            className="text-sm font-medium tabular-nums hover:underline disabled:cursor-default disabled:no-underline"
          >
            {sheet.sheetNumber}
          </button>
          {sheet.sheetTitle ? (
            <span className="ml-2 text-sm text-muted-foreground">{sheet.sheetTitle}</span>
          ) : null}
        </div>
        {sheet.changedRatio != null ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatRatio(sheet.changedRatio)} changed
          </span>
        ) : null}
      </div>

      {summary?.noSubstantiveChange ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          <Check className="mr-1.5 inline size-3 text-success" />
          Notes and title-block only — nothing here moves a quantity.
        </p>
      ) : null}

      {sheet.semantics ? (
        <ul className="mt-2.5 space-y-2">
          {sheet.semantics.regions.map((region, index) => (
            <li key={index} className="flex items-start gap-2.5 text-xs">
              <Badge
                variant="outline"
                className={cn("mt-px shrink-0 rounded-none font-normal", SEVERITY_STYLES[region.severity])}
              >
                {CHANGE_KIND_LABELS[region.kind as ChangeKind]}
              </Badge>
              <div className="min-w-0">
                <p>{region.summary}</p>
                {region.affected.length > 0 ? (
                  <p className="mt-0.5 flex items-center gap-1 text-muted-foreground">
                    <AlertTriangle className="size-3 shrink-0 text-warning" />
                    Affects {region.affected.map((entry) => entry.label).join(", ")}
                    {region.affectedRecords > region.affected.length
                      ? ` +${region.affectedRecords - region.affected.length} more`
                      : ""}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {sheet.regionCount} changed {sheet.regionCount === 1 ? "area" : "areas"} — open the sheet to
          compare.
        </p>
      )}

      {sheet.semantics?.truncated ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Showing the {sheet.semantics.regions.length} largest changed areas of {sheet.regionCount}.
        </p>
      ) : null}
    </div>
  )
}

function Stat({ label, value, alarm }: { label: string; value: number; alarm?: boolean }) {
  return (
    <div className="bg-card px-4 py-3">
      <p className="microlabel text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-xl font-semibold tabular-nums", alarm && "text-destructive")}>
        {value}
      </p>
    </div>
  )
}

function ReportSkeleton() {
  return (
    <div>
      <div className="grid grid-cols-3 gap-px border-b bg-border">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="bg-card px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-10" />
          </div>
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2 px-6 py-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  )
}

function formatRatio(ratio: number) {
  if (ratio > 0 && ratio < 0.001) return "<0.1%"
  return `${(ratio * 100).toFixed(1)}%`
}
