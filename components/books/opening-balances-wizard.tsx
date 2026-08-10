"use client"

import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { importOpeningBalancesAction } from "@/app/(app)/books/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  parseTrialBalance,
  type ParsedTrialBalanceRow,
} from "@/lib/financials/trial-balance-import"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

/**
 * Start Books on a date, from the trial balance of whatever system you are leaving.
 *
 * This replaces a textarea that wanted hand-written JSON with integer cents. The
 * job is not "import a file" — it is the one-time act of telling Arc what the
 * business was worth on the morning it started keeping its own books, and the
 * anxiety in it is "am I about to lose my history?". The answer is stated up
 * front rather than buried: history stays where it is. Arc never attempts a
 * historical migration, and the plan is explicit that it never should.
 */

type GlAccount = { id: string; code: string; name: string; account_type: string; active: boolean }

export function OpeningBalancesWizard({ accounts, asOf }: { accounts: GlAccount[]; asOf: string }) {
  const [cutoverDate, setCutoverDate] = useState(asOf)
  const [sourceFilename, setSourceFilename] = useState("")
  const [pasted, setPasted] = useState("")
  const [rows, setRows] = useState<ParsedTrialBalanceRow[] | null>(null)
  const [pending, startTransition] = useTransition()

  const active = useMemo(() => accounts.filter((account) => account.active), [accounts])

  const totals = useMemo(() => {
    const list = rows ?? []
    const debitCents = list.reduce((sum, row) => sum + row.debitCents, 0)
    const creditCents = list.reduce((sum, row) => sum + row.creditCents, 0)
    return { debitCents, creditCents, differenceCents: debitCents - creditCents }
  }, [rows])

  const unmapped = (rows ?? []).filter((row) => !row.accountCode && !row.problem).length
  const unreadable = (rows ?? []).filter((row) => row.problem).length
  const problem = !rows?.length
    ? "Paste a trial balance to begin."
    : unreadable > 0
      ? `${unreadable} line${unreadable === 1 ? "" : "s"} could not be read. Remove or fix them.`
      : unmapped > 0
        ? `${unmapped} line${unmapped === 1 ? "" : "s"} still need an Arc account.`
        : totals.debitCents === 0
          ? "Every amount is zero."
          : totals.differenceCents !== 0
            ? `Debits and credits differ by ${formatMoneyCentsExact(Math.abs(totals.differenceCents))}.`
            : null

  const submit = () => {
    if (!rows) return
    startTransition(async () => {
      const result = await importOpeningBalancesAction({
        cutoverDate,
        sourceFilename: sourceFilename.trim() || null,
        // The paste itself is the provenance — what the batch digest attests to.
        sourceContent: pasted,
        lines: rows.map((row) => ({
          accountCode: row.accountCode,
          description: row.sourceLabel,
          debitCents: row.debitCents,
          creditCents: row.creditCents,
        })),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success("Opening batch validated — it now needs owner and CPA approval")
      setRows(null)
      setPasted("")
    })
  }

  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Start Books on a date</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Paste the trial balance from the system you are leaving, as of the day before Arc
          takes over. Arc opens with those balances and keeps every transaction from that
          day forward.
        </p>
        <p className="mt-2 border-l-2 border-muted-foreground/30 pl-3 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">Your history stays where it is.</span>{" "}
          Arc does not import prior years and should not — the old system remains the record
          for anything before this date, and your accountant will still file from it. What
          moves across is the closing position, nothing else.
        </p>
      </div>

      <div className="grid gap-3 border-b px-5 py-4 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Books open on
          </span>
          <Input type="date" value={cutoverDate} onChange={(event) => setCutoverDate(event.target.value)} />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Source file name (optional)
          </span>
          <Input
            value={sourceFilename}
            onChange={(event) => setSourceFilename(event.target.value)}
            placeholder="QuickBooks trial balance 2026-06-30.csv"
          />
        </label>
      </div>

      <div className="border-b px-5 py-4">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Trial balance
          </span>
          <Textarea
            rows={8}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            className="font-mono text-xs"
            placeholder={"1000  Operating cash        125,000.00\n1100  Accounts receivable    48,200.00\n2000  Accounts payable                    31,700.00\n3000  Owner equity                       141,500.00"}
          />
        </label>
        <div className="mt-2 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setRows(parseTrialBalance(pasted, accounts))} disabled={!pasted.trim()}>
            Read trial balance
          </Button>
          <span className="text-xs text-muted-foreground">
            Tab, comma or column-aligned all work. Amounts may be one signed balance or
            separate debit and credit columns.
          </span>
        </div>
      </div>

      {rows?.length ? (
        <>
          <div className="overflow-x-auto px-5 py-4">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="text-left">
                  <th className="pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From your file</th>
                  <th className="pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Arc account</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Debit</th>
                  <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Credit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={cn("border-t", row.problem && "bg-destructive/5")}>
                    <td className="py-1.5 pr-3">
                      <span className="block truncate">{row.sourceLabel}</span>
                      {row.problem ? <span className="text-xs text-destructive">{row.problem}</span> : null}
                    </td>
                    <td className="py-1.5 pr-3">
                      <select
                        value={row.accountCode}
                        disabled={Boolean(row.problem)}
                        onChange={(event) =>
                          setRows((current) =>
                            (current ?? []).map((item) =>
                              item.key === row.key ? { ...item, accountCode: event.target.value } : item,
                            ),
                          )
                        }
                        className="flex h-8 w-full border border-input bg-transparent px-2 text-xs"
                        aria-label={`Arc account for ${row.sourceLabel}`}
                      >
                        <option value="">Choose account…</option>
                        {active.map((account) => (
                          <option key={account.id} value={account.code}>
                            {account.code} · {account.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono text-xs tabular-nums">
                      {row.debitCents ? formatMoneyCentsExact(row.debitCents) : "—"}
                    </td>
                    <td className="py-1.5 text-right font-mono text-xs tabular-nums">
                      {row.creditCents ? formatMoneyCentsExact(row.creditCents) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="grid grid-cols-3 border-t bg-muted/30">
            <div className="border-r px-5 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Debits</dt>
              <dd className="mt-0.5 font-mono text-sm tabular-nums">{formatMoneyCentsExact(totals.debitCents)}</dd>
            </div>
            <div className="border-r px-5 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Credits</dt>
              <dd className="mt-0.5 font-mono text-sm tabular-nums">{formatMoneyCentsExact(totals.creditCents)}</dd>
            </div>
            <div className="px-5 py-3">
              <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Difference</dt>
              <dd
                className={cn(
                  "mt-0.5 font-mono text-sm font-semibold tabular-nums",
                  totals.differenceCents === 0 && totals.debitCents > 0
                    ? "text-success"
                    : totals.differenceCents !== 0
                      ? "text-destructive"
                      : "text-muted-foreground",
                )}
              >
                {formatMoneyCentsExact(totals.differenceCents)}
              </dd>
            </div>
          </dl>
        </>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
        <p className="text-xs text-muted-foreground">
          {problem ?? "Balanced. Validating creates an immutable batch that still needs owner and CPA approval before it posts."}
        </p>
        <Button onClick={submit} disabled={Boolean(problem) || pending}>
          {pending ? "Validating…" : "Validate batch"}
        </Button>
      </div>
    </section>
  )
}
