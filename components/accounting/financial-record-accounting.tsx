"use client"

import Link from "next/link"
import { useEffect, useState } from "react"
import { ChevronDown, Loader2 } from "lucide-react"
import { loadFinancialRecordAccountingAction } from "@/app/(app)/financial-accounting-actions"
import { unwrapAction } from "@/lib/action-result"
import { accountingExperience } from "@/lib/financials/accounting-experience"
import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { Button } from "@/components/ui/button"

type Data = ReturnType<typeof unwrapResult>
function unwrapResult(result: Awaited<ReturnType<typeof loadFinancialRecordAccountingAction>>) { return unwrapAction(result) }

/** The same source record opens its native entries or provider history, without duplicate money. */
export function FinancialRecordAccounting({ type, id, version, defaultOpen = false }: {
  type: "vendor_bill" | "expense" | "invoice"
  id: string
  defaultOpen?: boolean
  version?: string | null
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; data?: Data; error?: string } | null>(null)
  const key = `${type}:${id}:${version ?? ""}:${attempt}`
  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadFinancialRecordAccountingAction({ type, id }).then(unwrapResult).then(
      data => { if (!cancelled) setState({ key, data }) },
      error => { if (!cancelled) setState({ key, error: error instanceof Error ? error.message : "Accounting could not be loaded." }) },
    )
    return () => { cancelled = true }
  }, [open, type, id, key])
  const current = state?.key === key ? state : null
  const data = current?.data
  const policy = data ? accountingExperience(data.mode) : null
  return <section className="border-t pt-3">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}
      className="flex w-full items-center justify-between gap-3 py-1 text-left text-sm font-medium">
      <span>{policy?.title ?? "Accounting"}</span><ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open ? <div className="space-y-3 pt-3">
      {!current ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Loading accounting…</p> : null}
      {current?.error ? <div role="alert" className="text-xs text-destructive">{current.error}<Button variant="outline" size="sm" className="ml-3" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div> : null}
      {data && policy ? <>
        <p className="text-xs text-muted-foreground">{policy.description}</p>
        {policy.showBooks ? <div className="space-y-2">
          <p className="microlabel">{policy.official ? "Journal entries" : "Preview journal entries"}</p>
          {!data.canReadBooks ? <p className="text-xs text-muted-foreground">Journal details are available to team members with access to Arc Books.</p> : data.entries.length ? data.entries.map(entry => <div key={entry.id} className="flex items-center justify-between gap-3 border-b py-2 text-xs">
            <span><span className="font-medium capitalize">{entry.status}</span> · {entry.entry_date}{entry.reversal_of_entry_id ? " · Reversal" : ""}</span>
            <Link href={`/books/ledger?entry=${entry.id}`} className="text-primary hover:underline">View entry</Link>
          </div>) : <p className="text-xs text-muted-foreground">No journal entry has been recorded for this item yet. Approval and posting are separate states.</p>}
          {data.entries.length === 20 ? <Link href="/books/ledger" className="text-xs text-primary hover:underline">Showing the latest 20 entries · Open ledger</Link> : null}
        </div> : null}
        {policy.showExternalSync ? <div className="space-y-2">
          <p className="microlabel">{policy.official ? "External mirror" : "Accounting sync"}</p>
          {data.sync.length ? data.sync.map(record => <div key={record.id} className="flex items-center justify-between gap-2 text-xs">
            <AccountingSyncBadge status={record.status} error={record.error_message} externalId={record.external_id}
              provider={record.provider} syncedAt={record.last_synced_at} />
          </div>) : <p className="text-xs text-muted-foreground">No sync receipt has been recorded for this item.</p>}
        </div> : null}
      </> : null}
    </div> : null}
  </section>
}
