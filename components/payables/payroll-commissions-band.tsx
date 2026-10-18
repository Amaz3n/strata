"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { markPayrollCommissionPaidAction } from "@/app/(app)/sales/commission-actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { unwrapAction } from "@/lib/action-result"
import type { PayrollCommissionRow } from "@/lib/services/sales-commissions"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

function today() {
  return new Date().toISOString().slice(0, 10)
}

function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** What payroll needs to key the run: one line per commission or clawback, signed. */
function payrollCsv(rows: PayrollCommissionRow[]) {
  const lines = [["Payee", "Home", "Kind", "Amount", "Accrued", "Commission id"].join(",")]
  for (const row of rows) {
    lines.push([
      csvCell(row.payeeName), csvCell(row.homeName), row.clawback ? "Clawback deduction" : "Commission",
      (row.amountCents / 100).toFixed(2), row.createdAt.slice(0, 10), row.id,
    ].join(","))
  }
  return `${lines.join("\n")}\n`
}

function exportCsv(rows: PayrollCommissionRow[]) {
  const url = URL.createObjectURL(new Blob([payrollCsv(rows)], { type: "text/csv" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `payroll-commissions-${today()}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export function PayrollCommissionsBandSkeleton() {
  return (
    <section className="border-b px-4 py-3 sm:px-6" aria-busy="true" aria-label="Loading payroll commissions">
      <div className="flex items-center justify-between"><Skeleton className="h-4 w-48" /><Skeleton className="h-8 w-28" /></div>
    </section>
  )
}

export function PayrollCommissionsBandError({ message }: { message: string }) {
  return (
    <section role="alert" className="border-b px-4 py-3 text-xs sm:px-6">
      <span className="font-medium">Commissions due to payroll</span>
      <span className="ml-2 text-destructive">{message}</span>
    </section>
  )
}

/**
 * Sales-consultant comp accrued at closing and clawbacks owed back, waiting for
 * the next payroll run. Payroll keys them from the export; once the run is
 * paid, each line is marked with its run reference through the closing
 * workbench's action, which is the line's one home.
 */
export function PayrollCommissionsBand({ rows, truncated }: { rows: PayrollCommissionRow[]; truncated: boolean }) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  const totalCents = rows.reduce((sum, row) => sum + row.amountCents, 0)
  return (
    <section className="border-b" aria-label="Commissions due to payroll">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6">
        <button type="button" className="flex items-baseline gap-2 text-left text-xs" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span className="font-medium">Commissions due to payroll</span>
          <span className="text-muted-foreground">
            <span className="tabular-nums text-foreground">{rows.length}</span> {rows.length === 1 ? "line" : "lines"} ·{" "}
            <span className="tabular-nums text-foreground">{formatMoneyCentsExact(totalCents)}</span>
            {truncated ? " · oldest shown first; more are waiting" : null}
          </span>
        </button>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Review"}</Button>
          <Button size="sm" variant="outline" onClick={() => exportCsv(rows)}>Export CSV</Button>
        </div>
      </div>
      {open ? (
        <div className="overflow-x-auto border-t">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground">
                <th className="px-4 py-1.5 font-normal sm:px-6">Payee</th>
                <th className="py-1.5 font-normal">Home</th>
                <th className="py-1.5 font-normal">Accrued</th>
                <th className="py-1.5 text-right font-normal">Amount</th>
                <th className="px-4 py-1.5 text-right font-normal sm:px-6">Payroll run</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => <PayrollCommissionLine key={row.id} row={row} />)}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  )
}

function PayrollCommissionLine({ row }: { row: PayrollCommissionRow }) {
  const router = useRouter()
  const [reference, setReference] = useState("")
  const [pending, startTransition] = useTransition()
  const markPaid = () => startTransition(async () => {
    try {
      unwrapAction(await markPayrollCommissionPaidAction(row.projectId, { obligationId: row.id, payrollReference: reference.trim(), paidOn: today() }))
      toast.success(`${row.payeeName}: marked paid by ${reference.trim()}`)
      router.refresh()
    } catch (error) {
      toast.error("Not marked paid", { description: error instanceof Error ? error.message : undefined })
    }
  })
  return (
    <tr className="transition-colors hover:bg-muted/40">
      <td className="px-4 py-1.5 font-medium sm:px-6">
        {row.payeeName}
        {row.clawback ? <span className="ml-2 text-[11px] font-normal text-destructive">Clawback deduction</span> : null}
      </td>
      <td className="max-w-[16rem] truncate py-1.5">
        <Link href={`/projects/${row.projectId}/closing`} className="hover:underline">{row.homeName}</Link>
      </td>
      <td className="py-1.5 text-muted-foreground tabular-nums">{row.createdAt.slice(0, 10)}</td>
      <td className={cn("py-1.5 text-right tabular-nums", row.amountCents < 0 && "text-destructive")}>{formatMoneyCentsExact(row.amountCents)}</td>
      <td className="px-4 py-1.5 sm:px-6">
        <div className="flex items-center justify-end gap-2">
          <Input aria-label={`Payroll run reference for ${row.payeeName}`} className="h-7 w-32 text-xs" placeholder="Run reference"
            value={reference} disabled={pending} onChange={(event) => setReference(event.target.value)} />
          <Button size="sm" variant="outline" className="h-7" disabled={pending || !reference.trim()} onClick={markPaid}>Mark paid</Button>
        </div>
      </td>
    </tr>
  )
}
