"use client"
import { intakeLabels, type IntakeRow } from "@/lib/payables/intake"
import styles from "./intake-status.module.css"
export function PayableIntakeStatus({ row, retry, dismiss }: { row: IntakeRow; retry: () => void; dismiss: () => void }) {
  if (row.stage === "ready") return <span className="text-xs text-warning" title={row.warning || undefined}>{row.warning || "Draft"}</span>
  if (row.stage === "failed") return <span className="flex flex-col items-start gap-1 py-2 text-xs">
    <span className="max-w-72 whitespace-normal text-destructive">{row.error || "The scan could not finish. Retry or enter the bill manually."}</span>
    <button className="underline underline-offset-4" onClick={event => { event.stopPropagation(); retry() }}>Retry</button>
    {!row.billId && <button className="text-muted-foreground" onClick={event => { event.stopPropagation(); dismiss() }}>Dismiss</button>}
  </span>
  return <span role="status" className={`text-xs ${styles.status}`}>{row.progress || (row.billId && row.stage === "queued" ? "Queued for scanning" : intakeLabels[row.stage])}</span>
}
