import Link from "next/link"

import { PoGenerationDialog } from "@/components/purchasing/po-generation-dialog"
import { formatDate } from "@/lib/reports/format"
import type { ProjectPoGenerationSummary } from "@/lib/services/po-generation"

/** A house's purchase-order generation on its budget page: last run, open exceptions, and the shared preview dialog. */
export function PoGenerationPanel({ projectId, projectName, summary }: { projectId: string; projectName: string; summary: ProjectPoGenerationSummary }) {
  const lastRun = summary.lastRunStatus
    ? `${summary.lastRunStatus.replaceAll("_", " ")}${summary.lastRunAt ? ` · ${formatDate(summary.lastRunAt)}` : ""}`
    : "No orders generated yet"
  return <div className="flex flex-wrap items-center gap-3 border-b bg-muted/15 px-6 py-3">
    <div className="min-w-0 flex-1">
      <div className="text-sm font-medium">Purchase-order generation</div>
      <div className="text-xs capitalize text-muted-foreground">{lastRun} · {summary.openExceptions} open {summary.openExceptions === 1 ? "exception" : "exceptions"}</div>
    </div>
    {summary.openExceptions > 0 && <Link href={`/purchasing?tab=exceptions&project=${projectId}`} className="text-sm underline underline-offset-2">Review exceptions</Link>}
    <PoGenerationDialog project={{ id: projectId, name: projectName, detail: "" }} />
  </div>
}
