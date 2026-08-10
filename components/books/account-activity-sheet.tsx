"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, X } from "lucide-react"

import { loadAccountActivityAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import type { AccountActivityRow } from "@/lib/services/books/statement-detail"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

/**
 * What is behind a number on a statement.
 *
 * Opened from any statement row: the account's entries for the period, in date
 * order, carrying a running balance — and from each entry, a link to the bill,
 * invoice or expense that caused it. This is the account register too; a
 * register is this list without a statement row to have arrived from.
 */

type ActivityResult = {
  account: { id: string; code: string; name: string; accountType: string; normalBalance: string }
  openingBalanceCents: number
  closingBalanceCents: number
  periodDebitCents: number
  periodCreditCents: number
  rows: AccountActivityRow[]
  truncated: boolean
  rowCap: number
}

export type ActivityTarget = {
  accountId: string
  code: string
  name: string
  projectId?: string | null
  projectName?: string | null
}

export function AccountActivitySheet({
  target,
  startDate,
  endDate,
  onOpenChange,
}: {
  target: ActivityTarget | null
  startDate: string
  endDate: string
  onOpenChange: (open: boolean) => void
}) {
  const [data, setData] = useState<ActivityResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!target) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setData(null)
    loadAccountActivityAction({
      accountId: target.accountId,
      startDate,
      endDate,
      projectId: target.projectId ?? null,
    })
      .then((result) => {
        if (cancelled) return
        if (result.success) setData(result.data as ActivityResult)
        else setError(result.error ?? "Could not load this account's activity.")
      })
      .catch(() => {
        if (!cancelled) setError("Could not load this account's activity.")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    // Re-fetch when the account, the project lens, or the period changes.
    return () => {
      cancelled = true
    }
  }, [target, startDate, endDate])

  return (
    <Sheet open={Boolean(target)} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl [&>button]:hidden"
      >
        <header className="flex items-start justify-between gap-4 border-b px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Account register
            </p>
            <h2 className="truncate text-sm font-semibold">
              <span className="font-mono text-muted-foreground">{target?.code}</span>{" "}
              {target?.name}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {startDate} → {endDate}
              {target?.projectName ? <> · {target.projectName}</> : null}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={() => onOpenChange(false)} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto">
          {loading ? <ActivitySkeleton /> : null}

          {!loading && error ? (
            <div className="px-5 py-12 text-center">
              <p className="text-sm font-medium">This register could not be loaded</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{error}</p>
            </div>
          ) : null}

          {!loading && !error && data ? (
            data.rows.length === 0 ? (
              <p className="px-5 py-12 text-center text-sm text-muted-foreground">
                No posted activity in this account for this period.
              </p>
            ) : (
              <>
                <dl className="grid grid-cols-2 border-b sm:grid-cols-4">
                  <Figure label="Opening" value={data.openingBalanceCents} />
                  <Figure label="Debits" value={data.periodDebitCents} />
                  <Figure label="Credits" value={data.periodCreditCents} />
                  <Figure label="Closing" value={data.closingBalanceCents} emphasis />
                </dl>

                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <Th>Date</Th>
                        <Th>Source</Th>
                        <Th>Detail</Th>
                        <Th className="text-right">Debit</Th>
                        <Th className="text-right">Credit</Th>
                        <Th className="text-right">Balance</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.map((row) => (
                        <tr key={row.lineId} className="border-b align-top">
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{row.entryDate}</td>
                          <td className="px-3 py-2">
                            {row.source?.href ? (
                              <Link
                                href={row.source.href}
                                className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
                              >
                                {row.source.label}
                                <ArrowUpRight className="h-3 w-3" />
                              </Link>
                            ) : (
                              <span className="font-medium">{row.source?.label ?? "Journal entry"}</span>
                            )}
                            {row.companyName ? (
                              <span className="block text-xs text-muted-foreground">{row.companyName}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">
                            <span className="block">{row.description || row.memo}</span>
                            {row.projectName ? (
                              <span className="block text-xs text-muted-foreground">{row.projectName}</span>
                            ) : null}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">
                            {row.debitCents ? formatMoneyCentsExact(row.debitCents) : <Dash />}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">
                            {row.creditCents ? formatMoneyCentsExact(row.creditCents) : <Dash />}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tabular-nums">
                            {formatMoneyCentsExact(row.balanceCents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {data.truncated ? (
                  <p className="border-t bg-muted/30 px-5 py-3 text-xs text-muted-foreground">
                    Showing the first {data.rowCap} entries of this period. Narrow the date range to
                    see the rest — the balances above cover only what is listed.
                  </p>
                ) : null}
              </>
            )
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Figure({ label, value, emphasis }: { label: string; value: number; emphasis?: boolean }) {
  return (
    <div className="border-r px-4 py-3 last:border-r-0">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 font-mono tabular-nums", emphasis ? "text-sm font-semibold" : "text-sm")}>
        {formatMoneyCentsExact(value)}
      </dd>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        "px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
        className,
      )}
    >
      {children}
    </th>
  )
}

function Dash() {
  return <span className="text-muted-foreground">—</span>
}

function ActivitySkeleton() {
  return (
    <div>
      <div className="grid grid-cols-2 border-b sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="border-r px-4 py-3 last:border-r-0">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-4 w-24" />
          </div>
        ))}
      </div>
      <div className="divide-y">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="grid grid-cols-[90px_1fr_110px_110px] gap-3 px-3 py-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>
    </div>
  )
}
