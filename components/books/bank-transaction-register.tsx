"use client"

import { useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn, formatMoneyCentsExact } from "@/lib/utils"

type Transaction = {
  id: string
  bank_account_id: string
  transaction_date: string
  amount_cents: number
  direction: string
  merchant_name: string | null
  description: string
}

const PAGE_SIZE = 50

export function BankTransactionRegister({
  transactions,
  unmatchedIds,
  accounts,
  sourceTruncated,
}: {
  transactions: Transaction[]
  unmatchedIds: string[]
  accounts: Array<{ id: string; name: string; official_name: string | null }>
  sourceTruncated: boolean
}) {
  const [search, setSearch] = useState("")
  const [accountId, setAccountId] = useState("all")
  const [direction, setDirection] = useState("all")
  const [match, setMatch] = useState("all")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [page, setPage] = useState(0)
  const [expanded, setExpanded] = useState<string | null>(null)
  const unmatched = useMemo(() => new Set(unmatchedIds), [unmatchedIds])
  const accountNames = useMemo(() => new Map(accounts.map((account) => [account.id, account.official_name || account.name])), [accounts])
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    return transactions.filter((transaction) => {
      const needsMatch = unmatched.has(transaction.id)
      return (
        (!query || `${transaction.merchant_name ?? ""} ${transaction.description} ${transaction.amount_cents}`.toLowerCase().includes(query)) &&
        (accountId === "all" || transaction.bank_account_id === accountId) &&
        (direction === "all" || transaction.direction === direction) &&
        (match === "all" || (match === "unmatched" ? needsMatch : !needsMatch)) &&
        (!startDate || transaction.transaction_date >= startDate) &&
        (!endDate || transaction.transaction_date <= endDate)
      )
    })
  }, [accountId, direction, endDate, match, search, startDate, transactions, unmatched])
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  const setFilter = (operation: () => void) => { operation(); setPage(0) }

  return (
    <section className="border bg-background">
      <div className="border-b px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold">Bank transaction register</p><p className="text-xs text-muted-foreground">Search and filter the normalized feed; expand a row for source detail.</p></div><Badge variant="outline">{filtered.length} of {transactions.length}</Badge></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_.8fr_.8fr_135px_135px]">
          <div className="relative"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input value={search} onChange={(event) => setFilter(() => setSearch(event.target.value))} className="pl-8" placeholder="Merchant, memo, or amount" /></div>
          <Select value={accountId} onValueChange={(value) => setFilter(() => setAccountId(value))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All accounts</SelectItem>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.official_name || account.name}</SelectItem>)}</SelectContent></Select>
          <Select value={direction} onValueChange={(value) => setFilter(() => setDirection(value))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All flows</SelectItem><SelectItem value="inflow">Money in</SelectItem><SelectItem value="outflow">Money out</SelectItem></SelectContent></Select>
          <Select value={match} onValueChange={(value) => setFilter(() => setMatch(value))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">Any status</SelectItem><SelectItem value="unmatched">Needs match</SelectItem><SelectItem value="matched">Matched</SelectItem></SelectContent></Select>
          <Input type="date" value={startDate} onChange={(event) => setFilter(() => setStartDate(event.target.value))} aria-label="Transactions from" />
          <Input type="date" value={endDate} onChange={(event) => setFilter(() => setEndDate(event.target.value))} aria-label="Transactions through" />
        </div>
      </div>
      <div className="divide-y">
        {visible.map((transaction) => {
          const open = expanded === transaction.id
          const needsMatch = unmatched.has(transaction.id)
          return (
            <div key={transaction.id}>
              <button type="button" onClick={() => setExpanded(open ? null : transaction.id)} className="grid w-full grid-cols-[16px_92px_1fr_auto_auto] items-center gap-3 px-4 py-3 text-left text-sm hover:bg-muted/30" aria-expanded={open}>
                <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
                <span className="font-mono text-xs text-muted-foreground">{transaction.transaction_date}</span>
                <span className="min-w-0"><span className="block truncate">{transaction.merchant_name || transaction.description}</span><span className="block truncate text-xs text-muted-foreground">{accountNames.get(transaction.bank_account_id) ?? "Bank account"}</span></span>
                <span className="font-mono tabular-nums">{transaction.direction === "outflow" ? "−" : "+"}{formatMoneyCentsExact(transaction.amount_cents)}</span>
                <Badge variant="outline" className={needsMatch ? "border-warning/30 bg-warning/10 text-warning" : ""}>{needsMatch ? "Needs match" : "Matched"}</Badge>
              </button>
              {open ? <div className="grid gap-2 border-t bg-muted/20 px-12 py-3 text-xs sm:grid-cols-2"><div><span className="text-muted-foreground">Description</span><p className="mt-0.5">{transaction.description || "—"}</p></div><div><span className="text-muted-foreground">Feed identity</span><p className="mt-0.5 font-mono">{transaction.id}</p></div></div> : null}
            </div>
          )
        })}
        {!visible.length ? <p className="px-5 py-12 text-center text-sm text-muted-foreground">No bank transactions match these filters.</p> : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
        <p>{sourceTruncated ? "The service supplied the 250 most recent rows; narrow by bank account for older activity." : `All ${transactions.length} supplied transactions are available in this register.`}</p>
        <div className="flex items-center gap-2"><span>Page {safePage + 1} of {pageCount}</span><Button size="icon" variant="outline" disabled={safePage === 0} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft className="h-4 w-4" /><span className="sr-only">Previous page</span></Button><Button size="icon" variant="outline" disabled={safePage >= pageCount - 1} onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}><ChevronRight className="h-4 w-4" /><span className="sr-only">Next page</span></Button></div>
      </div>
    </section>
  )
}
