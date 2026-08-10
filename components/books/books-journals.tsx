"use client"

import { useCallback, useEffect, useMemo, useState, useTransition } from "react"
import { ChevronRight, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  createRecurringTemplateAction,
  listJournalEntriesAction,
  listRecurringTemplatesAction,
  postAdjustingJournalAction,
  setRecurringTemplateStatusAction,
} from "@/app/(app)/books/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  JournalEntryListing,
  JournalEntrySummary,
  RecurringPostingTemplate,
} from "@/lib/services/books/bookkeeping"
import { parseMoneyToCents } from "@/lib/financials/money-input"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

/**
 * The journal: what is in it, and how a person adds to it.
 *
 * Until this existed the only way to post an adjusting entry was a textarea that
 * wanted hand-written JSON with integer cents, and recurring templates had a
 * service with no caller at all. No bookkeeper accepts a ledger they cannot post
 * into, so the editor is the point: real account pickers, dollars rather than
 * cents, and the balance asserted as you type instead of on submit.
 */

type GlAccount = {
  id: string
  code: string
  name: string
  account_type: string
  active: boolean
}

type DraftLine = {
  key: string
  accountCode: string
  description: string
  debit: string
  credit: string
}

// Derived from the services rather than restated, so a shape change here is a
// type error instead of a silently wrong render.
type JournalEntry = JournalEntrySummary
type JournalListing = JournalEntryListing
type RecurringTemplate = RecurringPostingTemplate

const KIND_FILTERS: Array<{ key: string; label: string; kinds?: string[] }> = [
  { key: "all", label: "All" },
  { key: "manual", label: "Hand-posted", kinds: ["adjusting", "opening"] },
  { key: "derived", label: "Derived", kinds: ["operational", "poc"] },
  { key: "closing", label: "Closing & reversals", kinds: ["closing", "reversal"] },
]

/** Unparseable input counts as 0 for totals; `useDraftProblem` reports it separately. */
function cents(value: string): number {
  return parseMoneyToCents(value) ?? 0
}

function emptyLine(): DraftLine {
  return { key: crypto.randomUUID(), accountCode: "", description: "", debit: "", credit: "" }
}

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

export function BooksJournals({ accounts, asOf }: { accounts: GlAccount[]; asOf: string }) {
  const [pane, setPane] = useState<"entries" | "new" | "recurring">("entries")

  return (
    <div className="desk-rise space-y-4">
      <nav className="flex flex-wrap gap-1" aria-label="Journal views">
        {[
          { key: "entries", label: "Entries" },
          { key: "new", label: "New entry" },
          { key: "recurring", label: "Recurring" },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setPane(item.key as typeof pane)}
            className={cn(
              "border px-3 py-1.5 text-sm transition-colors",
              pane === item.key
                ? "border-foreground bg-foreground text-background"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {pane === "entries" ? <EntriesPane /> : null}
      {pane === "new" ? <NewEntryPane accounts={accounts} asOf={asOf} /> : null}
      {pane === "recurring" ? <RecurringPane accounts={accounts} /> : null}
    </div>
  )
}

/** The audit view: which entries a person wrote, and which the projector derived. */
function EntriesPane() {
  const [filter, setFilter] = useState("all")
  const [data, setData] = useState<JournalListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(() => {
    const kinds = KIND_FILTERS.find((item) => item.key === filter)?.kinds
    setLoading(true)
    setError(null)
    listJournalEntriesAction(kinds ? { entryKinds: kinds } : {})
      .then((result) => {
        if (result.success) setData(result.data as JournalListing)
        else setError(result.error ?? "The journal could not be loaded.")
      })
      .catch(() => setError("The journal could not be loaded."))
      .finally(() => setLoading(false))
  }, [filter])

  useEffect(load, [load])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1">
        {KIND_FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={cn(
              "border px-2.5 py-1.5 text-xs transition-colors",
              filter === item.key ? "border-foreground text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {loading ? <ListSkeleton /> : null}

      {!loading && error ? (
        <div className="border bg-background px-5 py-12 text-center">
          <p className="text-sm font-medium">The journal could not be loaded</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{error}</p>
        </div>
      ) : null}

      {!loading && !error && data ? (
        data.entries.length === 0 ? (
          <div className="border bg-background px-5 py-12 text-center">
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              No journal entries match this filter.
            </p>
          </div>
        ) : (
          <section className="border bg-background">
            <div className="divide-y">
              {data.entries.map((entry) => {
                const isOpen = expanded === entry.id
                return (
                  <div key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : entry.id)}
                      aria-expanded={isOpen}
                      className="grid w-full grid-cols-[16px_88px_1fr_auto] items-start gap-3 px-4 py-3 text-left text-sm hover:bg-muted/40"
                    >
                      <ChevronRight
                        className={cn("mt-0.5 h-3.5 w-3.5 text-muted-foreground transition-transform", isOpen && "rotate-90")}
                      />
                      <span className="font-mono text-xs text-muted-foreground">{entry.entryDate}</span>
                      <span className="min-w-0">
                        <span className="block truncate">{entry.memo || "—"}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                          {entry.isManual ? (
                            <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning">
                              Hand-posted
                            </Badge>
                          ) : (
                            <Badge variant="outline">{entry.entryKind}</Badge>
                          )}
                          {entry.isReversal ? <Badge variant="outline">reversal</Badge> : null}
                          {entry.postedByName ? <span>{entry.postedByName}</span> : null}
                          {entry.sourceType ? <span className="font-mono">{entry.sourceType}</span> : null}
                        </span>
                      </span>
                      <span className="font-mono tabular-nums">{formatMoneyCentsExact(entry.totalCents)}</span>
                    </button>
                    {isOpen ? (
                      <div className="border-t bg-muted/20 px-4 py-3">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-left text-muted-foreground">
                              <th className="pb-1 font-medium">Account</th>
                              <th className="pb-1 font-medium">Description</th>
                              <th className="pb-1 text-right font-medium">Debit</th>
                              <th className="pb-1 text-right font-medium">Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {entry.lines.map((line) => (
                              <tr key={line.id}>
                                <td className="py-0.5">
                                  <span className="font-mono text-muted-foreground">{line.accountCode}</span>{" "}
                                  {line.accountName}
                                </td>
                                <td className="py-0.5 text-muted-foreground">{line.description ?? "—"}</td>
                                <td className="py-0.5 text-right font-mono tabular-nums">
                                  {line.debitCents ? formatMoneyCentsExact(line.debitCents) : "—"}
                                </td>
                                <td className="py-0.5 text-right font-mono tabular-nums">
                                  {line.creditCents ? formatMoneyCentsExact(line.creditCents) : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        <p className="mt-2 font-mono text-[10px] text-muted-foreground">{entry.postingKey}</p>
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
            {data.truncated ? (
              <p className="border-t bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
                Showing the most recent {data.rowCap} entries. Narrow the filter to see older ones.
              </p>
            ) : null}
          </section>
        )
      ) : null}
    </div>
  )
}

function NewEntryPane({ accounts, asOf }: { accounts: GlAccount[]; asOf: string }) {
  const [entryDate, setEntryDate] = useState(asOf || todayIso())
  const [memo, setMemo] = useState("")
  const [reversingOn, setReversingOn] = useState("")
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()])
  const [pending, startTransition] = useTransition()

  const totals = useTotals(lines)
  const problem = useDraftProblem({ memo, lines, totals })

  const submit = () => {
    startTransition(async () => {
      const result = await postAdjustingJournalAction({
        entryDate,
        memo,
        reversingOn: reversingOn || null,
        lines: toPayloadLines(lines),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(reversingOn ? "Adjustment posted, with its reversal scheduled" : "Adjustment posted")
      setMemo("")
      setReversingOn("")
      setLines([emptyLine(), emptyLine()])
    })
  }

  return (
    <section className="border bg-background">
      <div className="border-b px-5 py-4">
        <p className="text-sm font-semibold">Post an adjusting entry</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Posted entries are immutable — a correction reverses and reposts. Set a reversing
          date for an accrual that should back itself out next period.
        </p>
      </div>

      <div className="grid gap-3 border-b px-5 py-4 sm:grid-cols-3">
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Entry date</span>
          <Input type="date" value={entryDate} onChange={(event) => setEntryDate(event.target.value)} required />
        </label>
        <label className="space-y-1 sm:col-span-2">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Memo</span>
          <Input
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            placeholder="Why this entry exists"
            required
          />
        </label>
        <label className="space-y-1">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Reversing on (optional)
          </span>
          <Input type="date" value={reversingOn} onChange={(event) => setReversingOn(event.target.value)} />
        </label>
      </div>

      <LineEditor accounts={accounts} lines={lines} onChange={setLines} />
      <BalanceBar totals={totals} />

      <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
        <p className="text-xs text-muted-foreground">{problem ?? "Balanced and ready to post."}</p>
        <Button onClick={submit} disabled={Boolean(problem) || pending}>
          {pending ? "Posting…" : "Post entry"}
        </Button>
      </div>
    </section>
  )
}

function RecurringPane({ accounts }: { accounts: GlAccount[] }) {
  const [templates, setTemplates] = useState<RecurringTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [pending, startTransition] = useTransition()

  const [name, setName] = useState("")
  const [memo, setMemo] = useState("")
  const [frequency, setFrequency] = useState<"weekly" | "monthly" | "quarterly" | "annually">("monthly")
  const [nextRunOn, setNextRunOn] = useState(todayIso())
  const [endOn, setEndOn] = useState("")
  const [autoPost, setAutoPost] = useState(false)
  const [lines, setLines] = useState<DraftLine[]>([emptyLine(), emptyLine()])

  const totals = useTotals(lines)
  const problem = useDraftProblem({ memo, lines, totals }) ?? (name.trim().length < 2 ? "Give the template a name." : null)

  const load = useCallback(() => {
    setLoading(true)
    setError(null)
    listRecurringTemplatesAction()
      .then((result) => {
        if (result.success) setTemplates(result.data as RecurringTemplate[])
        else setError(result.error ?? "Recurring templates could not be loaded.")
      })
      .catch(() => setError("Recurring templates could not be loaded."))
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const create = () => {
    startTransition(async () => {
      const result = await createRecurringTemplateAction({
        name,
        memo,
        frequency,
        nextRunOn,
        endOn: endOn || null,
        autoPost,
        lines: toPayloadLines(lines),
      })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success("Recurring template created")
      setName("")
      setMemo("")
      setEndOn("")
      setAutoPost(false)
      setLines([emptyLine(), emptyLine()])
      setCreating(false)
      load()
    })
  }

  const changeStatus = (templateId: string, status: "active" | "paused") => {
    startTransition(async () => {
      const result = await setRecurringTemplateStatusAction({ templateId, status })
      if (!result.success) {
        toast.error(result.error)
        return
      }
      toast.success(status === "paused" ? "Template paused" : "Template resumed")
      load()
    })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Templates post on their schedule. Without auto-post they raise a notification when due
          and wait for someone to approve.
        </p>
        <Button variant="outline" size="sm" onClick={() => setCreating((value) => !value)}>
          <Plus className="mr-1 h-3.5 w-3.5" />
          {creating ? "Cancel" : "New template"}
        </Button>
      </div>

      {creating ? (
        <section className="border bg-background">
          <div className="grid gap-3 border-b px-5 py-4 sm:grid-cols-3">
            <label className="space-y-1 sm:col-span-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Name</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Monthly depreciation" />
            </label>
            <label className="space-y-1 sm:col-span-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Memo</span>
              <Input value={memo} onChange={(event) => setMemo(event.target.value)} placeholder="Posted to each entry" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Frequency</span>
              <select
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as typeof frequency)}
                className="flex h-9 w-full border border-input bg-transparent px-3 text-sm"
              >
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="annually">Annually</option>
              </select>
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Next run</span>
              <Input type="date" value={nextRunOn} onChange={(event) => setNextRunOn(event.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Ends on (optional)
              </span>
              <Input type="date" value={endOn} onChange={(event) => setEndOn(event.target.value)} />
            </label>
            <label className="flex items-center gap-2 sm:col-span-3">
              <input
                type="checkbox"
                checked={autoPost}
                onChange={(event) => setAutoPost(event.target.checked)}
                className="size-4"
              />
              <span className="text-sm">Post automatically without approval</span>
            </label>
          </div>
          <LineEditor accounts={accounts} lines={lines} onChange={setLines} />
          <BalanceBar totals={totals} />
          <div className="flex items-center justify-between gap-3 border-t px-5 py-4">
            <p className="text-xs text-muted-foreground">{problem ?? "Balanced and ready to save."}</p>
            <Button onClick={create} disabled={Boolean(problem) || pending}>
              {pending ? "Saving…" : "Create template"}
            </Button>
          </div>
        </section>
      ) : null}

      {loading ? <ListSkeleton /> : null}

      {!loading && error ? (
        <div className="border bg-background px-5 py-12 text-center">
          <p className="text-sm font-medium">Recurring templates could not be loaded</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{error}</p>
        </div>
      ) : null}

      {!loading && !error && templates ? (
        templates.length === 0 ? (
          <div className="border bg-background px-5 py-12 text-center">
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              No recurring templates yet. Depreciation, amortised insurance and management fees are
              the usual first three.
            </p>
          </div>
        ) : (
          <section className="border bg-background divide-y">
            {templates.map((template) => (
              <div key={template.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{template.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{template.memo}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="outline">{template.frequency}</Badge>
                      {template.status !== "active" ? <Badge variant="outline">{template.status}</Badge> : null}
                      {template.autoPost ? (
                        <Badge variant="outline">auto-post</Badge>
                      ) : (
                        <Badge variant="outline">needs approval</Badge>
                      )}
                      <span>next {template.nextRunOn}</span>
                      {template.endOn ? <span>· ends {template.endOn}</span> : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm tabular-nums">{formatMoneyCentsExact(template.totalCents)}</span>
                    {template.status !== "completed" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => changeStatus(template.id, template.status === "paused" ? "active" : "paused")}
                      >
                        {template.status === "paused" ? "Resume" : "Pause"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                <ul className="mt-2 space-y-0.5">
                  {template.lines.map((line) => (
                    <li key={line.id} className="flex justify-between gap-3 text-xs text-muted-foreground">
                      <span>
                        <span className="font-mono">{line.accountCode}</span> {line.accountName}
                      </span>
                      <span className="font-mono tabular-nums">
                        {line.debitCents ? `Dr ${formatMoneyCentsExact(line.debitCents)}` : `Cr ${formatMoneyCentsExact(line.creditCents)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )
      ) : null}
    </div>
  )
}

function LineEditor({
  accounts,
  lines,
  onChange,
}: {
  accounts: GlAccount[]
  lines: DraftLine[]
  onChange: (next: DraftLine[]) => void
}) {
  const active = useMemo(() => accounts.filter((account) => account.active), [accounts])
  const update = (key: string, patch: Partial<DraftLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)))

  return (
    <div className="px-5 py-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-sm">
          <thead>
            <tr className="text-left">
              <th className="pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Account</th>
              <th className="pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Description</th>
              <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Debit</th>
              <th className="pb-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Credit</th>
              <th className="w-9 pb-2" />
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key}>
                <td className="py-1 pr-2">
                  <select
                    value={line.accountCode}
                    onChange={(event) => update(line.key, { accountCode: event.target.value })}
                    className="flex h-9 w-full border border-input bg-transparent px-2 text-sm"
                    aria-label="Account"
                  >
                    <option value="">Select account</option>
                    {active.map((account) => (
                      <option key={account.id} value={account.code}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={line.description}
                    onChange={(event) => update(line.key, { description: event.target.value })}
                    placeholder="Optional"
                    aria-label="Line description"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={line.debit}
                    // A line is one side or the other; typing in one clears the other so a
                    // line can never claim to be both.
                    onChange={(event) => update(line.key, { debit: event.target.value, credit: "" })}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="text-right font-mono tabular-nums"
                    aria-label="Debit"
                  />
                </td>
                <td className="py-1 pr-2">
                  <Input
                    value={line.credit}
                    onChange={(event) => update(line.key, { credit: event.target.value, debit: "" })}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="text-right font-mono tabular-nums"
                    aria-label="Credit"
                  />
                </td>
                <td className="py-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove line"
                    disabled={lines.length <= 2}
                    onClick={() => onChange(lines.filter((row) => row.key !== line.key))}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button variant="outline" size="sm" className="mt-2" onClick={() => onChange([...lines, emptyLine()])}>
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add line
      </Button>
    </div>
  )
}

/** The balance assertion, live. A journal that does not balance cannot be posted. */
function BalanceBar({ totals }: { totals: { debitCents: number; creditCents: number; differenceCents: number } }) {
  const balanced = totals.differenceCents === 0 && totals.debitCents > 0
  return (
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
            balanced ? "text-success" : totals.differenceCents !== 0 ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {formatMoneyCentsExact(totals.differenceCents)}
        </dd>
      </div>
    </dl>
  )
}

function useTotals(lines: DraftLine[]) {
  return useMemo(() => {
    const debitCents = lines.reduce((sum, line) => sum + cents(line.debit), 0)
    const creditCents = lines.reduce((sum, line) => sum + cents(line.credit), 0)
    return { debitCents, creditCents, differenceCents: debitCents - creditCents }
  }, [lines])
}

/** The single reason the draft cannot be posted, in the order a person would hit them. */
function useDraftProblem({
  memo,
  lines,
  totals,
}: {
  memo: string
  lines: DraftLine[]
  totals: { debitCents: number; creditCents: number; differenceCents: number }
}) {
  return useMemo(() => {
    if (memo.trim().length < 4) return "Add a memo explaining why this entry exists."
    const used = lines.filter((line) => line.accountCode && (cents(line.debit) || cents(line.credit)))
    if (used.length < 2) return "A journal entry needs at least two lines with an account and an amount."
    if (lines.some((line) => !line.accountCode && (cents(line.debit) || cents(line.credit)))) {
      return "Every line with an amount needs an account."
    }
    if (totals.debitCents === 0) return "Enter the amounts."
    if (totals.differenceCents !== 0) {
      return `Debits and credits differ by ${formatMoneyCentsExact(Math.abs(totals.differenceCents))}.`
    }
    return null
  }, [memo, lines, totals])
}

function toPayloadLines(lines: DraftLine[]) {
  return lines
    .filter((line) => line.accountCode && (cents(line.debit) || cents(line.credit)))
    .map((line) => ({
      accountCode: line.accountCode,
      debitCents: cents(line.debit),
      creditCents: cents(line.credit),
      description: line.description.trim() || undefined,
    }))
}

function ListSkeleton() {
  return (
    <div className="border bg-background divide-y">
      {Array.from({ length: 6 }).map((_, index) => (
        <div key={index} className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-24" />
        </div>
      ))}
    </div>
  )
}
