"use client"

/**
 * Sheet coverage — which drawings have been taken off, and which were missed.
 *
 * Every other honesty signal in the takeoff describes measurements that exist.
 * This one describes the ones that never got made, which is the error that
 * actually costs money: a whole second-floor electrical plan skipped does not
 * read as a wrong number, it reads as a number.
 *
 * "Not started" is the only row that needs action, so it leads. A sheet can be
 * waived ("nothing to measure here" — schedules, general notes) and that waiver
 * is a claim a person made, shown as such.
 */

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { AlertTriangle, Check, Loader2, Minus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"
import { unwrapAction } from "@/lib/action-result"
import type { CoverageSummary, SheetCoverage } from "@/lib/services/takeoff-coverage"
import {
  getTakeoffCoverageAction,
  setTakeoffSheetStatusAction,
} from "@/app/(app)/drawings/takeoff-actions"

type CoverageScope =
  | { project_id: string }
  | { house_plan_version_id: string; source_project_ids: string[] }

const STATE_LABEL: Record<SheetCoverage["state"], string> = {
  not_started: "Not started",
  measured: "Measured",
  complete: "Done",
  not_applicable: "Nothing to measure",
}

export function SheetCoverageSheet({
  open,
  scope,
  declarationScope,
  canWrite,
  onOpenChange,
}: {
  open: boolean
  scope: CoverageScope
  /** Which takeoff the declaration belongs to — a project or a plan version. */
  declarationScope: { project_id: string } | { house_plan_version_id: string } | null
  canWrite: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [summary, setSummary] = useState<CoverageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busySheetId, setBusySheetId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const result = await getTakeoffCoverageAction(scope)
      if (result.success) setSummary(result.data)
      else {
        setError(result.error)
        setSummary(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load coverage")
      setSummary(null)
    }
    // The scope object is rebuilt each render by the panel; serialising it keeps
    // this from reloading on every parent state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(scope)])

  useEffect(() => {
    void load()
  }, [load])

  const declare = useCallback(
    async (sheet: SheetCoverage, status: "complete" | "not_applicable" | null) => {
      if (!declarationScope) return
      setBusySheetId(sheet.drawing_sheet_id)
      try {
        unwrapAction(
          await setTakeoffSheetStatusAction({
            ...declarationScope,
            drawing_sheet_id: sheet.drawing_sheet_id,
            status,
          }),
        )
        await load()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update the sheet")
      } finally {
        setBusySheetId(null)
      }
    },
    [declarationScope, load],
  )

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Sheet coverage</SheetTitle>
          <SheetDescription>
            Which sheets you have measured, and which nobody has looked at yet.
          </SheetDescription>
        </SheetHeader>

        {summary === null && !error ? (
          <div className="mt-4 space-y-2" aria-busy>
            {Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="h-9 animate-pulse bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-center">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        ) : !summary || summary.sheets.length === 0 ? (
          <div className="mt-10 space-y-1.5 text-center">
            <p className="text-sm font-medium">No published sheets</p>
            <p className="text-xs text-muted-foreground">
              Upload and publish a drawing set and its sheets appear here.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4 flex items-baseline gap-4 border-y py-2.5 text-xs">
              <span className={cn("tabular-nums", summary.not_started_count > 0 && "text-warning")}>
                <span className="text-base font-semibold">{summary.not_started_count}</span> not
                started
              </span>
              <span className="tabular-nums text-muted-foreground">
                {summary.measured_count} measured
              </span>
              <span className="tabular-nums text-muted-foreground">
                {summary.waived_count} waived
              </span>
            </div>

            {summary.truncated && (
              <p className="mt-2 text-[11px] text-warning">
                This set is larger than one pass can list — sheets beyond the first 1,000 are
                not shown.
              </p>
            )}

            <ScrollArea className="mt-2 h-[calc(100vh-15rem)]">
              <ul className="divide-y pr-2">
                {summary.sheets.map((sheet) => (
                  <CoverageRow
                    key={sheet.drawing_sheet_id}
                    sheet={sheet}
                    canWrite={canWrite && !!declarationScope}
                    busy={busySheetId === sheet.drawing_sheet_id}
                    onDeclare={(status) => void declare(sheet, status)}
                  />
                ))}
              </ul>
            </ScrollArea>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function CoverageRow({
  sheet,
  canWrite,
  busy,
  onDeclare,
}: {
  sheet: SheetCoverage
  canWrite: boolean
  busy: boolean
  onDeclare: (status: "complete" | "not_applicable" | null) => void
}) {
  const untouched = sheet.state === "not_started"
  const waived = sheet.state === "not_applicable"

  return (
    <li className="flex items-start gap-2 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium tabular-nums">{sheet.sheet_number}</span>
          <span className="truncate text-xs text-muted-foreground">{sheet.sheet_title ?? "—"}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px]">
          <span className={cn(untouched ? "text-warning" : "text-muted-foreground")}>
            {STATE_LABEL[sheet.state]}
          </span>
          {sheet.markup_count > 0 && (
            <span className="tabular-nums text-muted-foreground">
              {sheet.markup_count} measurement{sheet.markup_count === 1 ? "" : "s"}
            </span>
          )}
          {sheet.unscaled && !waived && (
            <span className="text-warning">No scale — nothing here can be priced</span>
          )}
          {sheet.declared_note && (
            <span className="truncate text-muted-foreground">{sheet.declared_note}</span>
          )}
        </div>
      </div>

      {canWrite && (
        <div className="flex shrink-0 items-center gap-1">
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          ) : (
            <>
              <Button
                size="icon"
                variant="ghost"
                className={cn("h-7 w-7", sheet.state === "complete" && "bg-muted")}
                aria-label={
                  sheet.state === "complete"
                    ? `Unmark ${sheet.sheet_number} as done`
                    : `Mark ${sheet.sheet_number} done`
                }
                onClick={() => onDeclare(sheet.state === "complete" ? null : "complete")}
              >
                <Check className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className={cn("h-7 w-7", waived && "bg-muted")}
                aria-label={
                  waived
                    ? `Unmark ${sheet.sheet_number} as nothing to measure`
                    : `Mark ${sheet.sheet_number} as nothing to measure`
                }
                onClick={() => onDeclare(waived ? null : "not_applicable")}
              >
                <Minus className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
        </div>
      )}
    </li>
  )
}
