"use client"

import Link from "next/link"
import { useState } from "react"

import type { ReportRunDTO } from "@/lib/services/report-runs"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { History } from "@/components/icons"

function formatRunTime(iso: string) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

const FORMAT_LABELS: Record<string, string> = {
  csv: "CSV",
  pdf: "PDF",
  json: "JSON",
  view: "Viewed",
}

/**
 * Prior pulls of this report. The live numbers move; a run does not — this is
 * how someone answers "what did the schedule say when we sent it to the bank".
 */
export function ReportRunsSheet({ runs, runHrefBase }: { runs: ReportRunDTO[]; runHrefBase: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <History className="size-4" />
          Runs
          {runs.length > 0 ? <span className="text-muted-foreground">{runs.length}</span> : null}
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Run history</SheetTitle>
          <SheetDescription>
            Every export is snapshotted. Open one to see exactly the numbers that left the building.
          </SheetDescription>
        </SheetHeader>

        <div className="overflow-y-auto px-4 pb-6">
          {runs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              No runs yet. Exporting this report records one.
            </p>
          ) : (
            <ul className="divide-y border-t">
              {runs.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`${runHrefBase}?run=${run.id}`}
                    onClick={() => setOpen(false)}
                    className="block py-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm font-medium">{formatRunTime(run.createdAt)}</span>
                      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {FORMAT_LABELS[run.format] ?? run.format}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {run.rowCount.toLocaleString()} row{run.rowCount === 1 ? "" : "s"}
                      {run.runByName ? ` · ${run.runByName}` : ""}
                      {run.subtitle ? ` · ${run.subtitle}` : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
